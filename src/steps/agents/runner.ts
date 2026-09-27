import { type LanguageModel, wrapLanguageModel } from "ai";
import { formatFailures, runChecks } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import { JitCheckError } from "../../workflow/agents/agent.ts";
import type { Harness } from "../../workflow/agents/harness-config.ts";
import { type AgentSessionRef, extractAgentSession } from "../../workflow/agents/result.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import type { Driver, HarnessTarget } from "./drivers/index.ts";
import { harnessEnv } from "./harnesses/env.ts";
import { acquireFileLock, FileLockTimeoutError, lockPathFor } from "./lock.ts";
import { type RunCancellation, watchRunCancellation } from "./run-cancellation.ts";
import { type ExecutionSeams, executionSeams } from "./seams.ts";
import { AgentSessionError } from "./session-error.ts";

/**
 * A harness ready to run in a worktree, from {@link createAgentRunner}. Pass `model` to the AI
 * SDK's `generateText`, read the session reference from its result with `sessionFrom`, and call
 * `close` when the call is done.
 *
 * @group Agent runner
 */
export interface AgentRunner {
  /** The live provider model, with jigs' policy already applied. */
  model: LanguageModel;
  /** The session reference in a `generateText` result, for a later step to resume. */
  sessionFrom(result: {
    providerMetadata?: Record<string, Record<string, unknown>> | null | undefined;
  }): AgentSessionRef | undefined;
  /** Release the worktree lock and stop what the harness started. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Where {@link createAgentRunner} runs a harness, and the session it resumes.
 *
 * @group Agent runner
 */
export interface AgentRunnerOptions {
  /** The worktree the agent works in. */
  cwd: string;
  /** The run the step belongs to: `getWorkflowMetadata()` inside the step. */
  run: RunMetadata;
  /** A session reference from an earlier call to resume. */
  resume?: AgentSessionRef | undefined;
}

export interface PreparedRun {
  driver: Driver<Harness["kind"]>;
  env: Record<string, string>;
  release(): void;
}

const LOCK_STALE_MS = 4 * 60 * 60_000 + 60_000;

// Everything the built-in agent step does before it reaches the harness. Throws
// AgentSessionError for a session recorded on another harness and JitCheckError
// for a failed just-in-time check; the lock is held until `release`.
export async function prepareAgentRun(
  target: HarnessTarget,
  seams: ExecutionSeams,
): Promise<PreparedRun> {
  const { harness, cwd, resume } = target;
  const driver = seams.resolveDriver(harness.kind);
  if (driver === undefined) throw new JigsError(`no driver is registered for ${harness.kind}`);
  if (driver.family !== "harness")
    throw new JigsError(`${harness.kind} is a model source, not an agent harness`);
  if (resume !== undefined && resume.harness !== harness.kind) {
    throw new AgentSessionError(
      `session ${resume.id} was recorded on the ${resume.harness} harness and this step runs on ${harness.kind}`,
    );
  }
  // Built once, so the JIT checks probe exactly what the harness gets.
  const env = harnessEnv([...driver.envAllowlist(target), ...seams.factoryEnv()]);
  const requestReport = await runChecks(driver.requestChecks(target));
  if (!requestReport.ok) throw new JigsError(formatFailures(requestReport));
  const jitFailure = await seams.jitFailures(target, env);
  if (jitFailure !== undefined) throw new JitCheckError(jitFailure);
  try {
    const release = await acquireFileLock(lockPathFor(cwd, "agent-step"), {
      timeoutMs: 0,
      staleMs: LOCK_STALE_MS,
    });
    return { driver, env, release };
  } catch (err) {
    if (err instanceof FileLockTimeoutError)
      throw new Error(
        `an agent is already running in ${cwd} — refusing to start a second one in the same worktree`,
      );
    throw err;
  }
}

// The runner as jigs' own agent step holds it: the signal and error
// classification of the run's cancellation watch, which lives until `close`.
// The step passes the signal to the AI SDK itself.
export interface OpenedAgentRunner extends AgentRunner {
  signal: AbortSignal;
  classify(error: unknown): unknown;
}

// A factory's step hands the model to the AI SDK itself, without our signal, so
// the model carries it into every provider call. A provider stopped by the
// cancellation fails in its own words, such as Codex's "app-server exited";
// once the run is cancelled every failure becomes the fatal cancellation, so
// the SDK records no retry.
export function forFactoryStep(runner: OpenedAgentRunner): AgentRunner {
  const { model, signal } = runner;
  const rethrow = (error: unknown): never => {
    throw signal.aborted ? signal.reason : error;
  };
  return {
    model:
      typeof model === "string"
        ? model
        : wrapLanguageModel({
            model,
            middleware: {
              transformParams: async ({ params }) => ({
                ...params,
                abortSignal:
                  params.abortSignal === undefined
                    ? signal
                    : AbortSignal.any([params.abortSignal, signal]),
              }),
              wrapGenerate: ({ doGenerate }) => doGenerate().then(undefined, rethrow),
              wrapStream: async ({ doStream }) => {
                const result = await doStream().then(undefined, rethrow);
                const parts = result.stream.getReader();
                // The SDK turns an error part into an empty result, so a
                // cancelled stream fails as a stream instead.
                const stream: typeof result.stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await parts.read().catch(rethrow);
                    if (signal.aborted) throw signal.reason;
                    if (done) controller.close();
                    else controller.enqueue(value);
                  },
                  cancel: (reason) => parts.cancel(reason),
                });
                return { ...result, stream };
              },
            },
          }),
    sessionFrom: runner.sessionFrom,
    close: runner.close,
  };
}

export async function openAgentRunner(
  harness: Harness,
  options: AgentRunnerOptions,
  seams: ExecutionSeams,
): Promise<OpenedAgentRunner> {
  if (harness.kind === "pi")
    throw new JigsError(
      "createAgentRunner cannot open a Pi harness: Pi has no AI SDK provider model. Run Pi with runAgent from #jigs/routines",
    );
  const target: HarnessTarget = { harness, cwd: options.cwd, resume: options.resume };
  const prepared = await prepareAgentRun(target, seams);
  const { driver } = prepared;
  let watch: RunCancellation | undefined;
  try {
    if (driver.open === undefined) throw new JigsError(`the ${harness.kind} driver cannot run`);
    watch = await watchRunCancellation(options.run.workflowRunId, seams.runStatus);
    const cancellation = watch;
    const opened = await driver.open(target, {
      metadata: options.run,
      env: prepared.env,
      signal: cancellation.signal,
    });
    let closing: Promise<void> | undefined;
    return {
      model: opened.model,
      signal: cancellation.signal,
      classify: cancellation.classify,
      sessionFrom: (result) =>
        extractAgentSession(harness, result.providerMetadata, driver.sessionPointer),
      close: () => {
        closing ??= opened.close().finally(() => {
          cancellation.dispose();
          prepared.release();
        });
        return closing;
      },
    };
  } catch (err) {
    watch?.dispose();
    prepared.release();
    throw watch === undefined ? err : watch.classify(err);
  }
}

/**
 * Open a Claude Code or Codex harness inside a factory's own step, the way the built-in agent
 * step does: the environment allowlist with the factory's `agents.env`, the request and
 * just-in-time checks, the worktree lock, Codex's private home and app server, and the Claude
 * spawn hook. The returned `model` is the live provider, ready for `generateText`.
 *
 * @remarks
 * Call it inside a `"use step"` function, never in a workflow. The step can hand the provider a
 * function, such as a tool-approval hook or a logger, because a step runs where functions are
 * allowed; pass it through the AI SDK call.
 *
 * It throws `JitCheckError` when a just-in-time check fails, and {@link AgentSessionError} when
 * `resume` names a session this harness cannot resume. Pi has no provider model, so a Pi
 * descriptor throws: run Pi with `runAgent`.
 *
 * It reads the run's status before opening the harness and watches it until `close`. It throws
 * a fatal error instead of opening on a cancelled run, and once the run is cancelled every
 * provider call through `model` is aborted and fails with that fatal error.
 *
 * @example
 * ```ts
 * import type { AgentSessionRef, Harness } from "@jigs-ai/jigs";
 * import { createAgentRunner } from "@jigs-ai/jigs/steps";
 * import { generateText } from "ai";
 * import { getWorkflowMetadata } from "workflow";
 *
 * export async function runWithTemperature(request: {
 *   harness: Harness;
 *   cwd: string;
 *   prompt: string;
 *   resume?: AgentSessionRef | undefined;
 * }) {
 *   "use step";
 *   const runner = await createAgentRunner(request.harness, {
 *     cwd: request.cwd,
 *     run: getWorkflowMetadata(),
 *     resume: request.resume,
 *   });
 *   try {
 *     const result = await generateText({ model: runner.model, prompt: request.prompt, temperature: 0 });
 *     return { text: result.text, session: runner.sessionFrom(result) };
 *   } finally {
 *     await runner.close();
 *   }
 * }
 * ```
 *
 * @group Agent runner
 */
export async function createAgentRunner(
  harness: Harness,
  options: AgentRunnerOptions,
): Promise<AgentRunner> {
  return forFactoryStep(await openAgentRunner(harness, options, executionSeams));
}
