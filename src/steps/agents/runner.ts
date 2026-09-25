import type { LanguageModel } from "ai";
import { formatFailures, runChecks } from "../../checks/catalog.ts";
import { JigsError } from "../../errors.ts";
import { JitCheckError } from "../../workflow/agents/agent.ts";
import type { Harness } from "../../workflow/agents/harness-config.ts";
import { type AgentSessionRef, extractAgentSession } from "../../workflow/agents/result.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import type { Driver, HarnessTarget } from "./drivers/index.ts";
import { harnessEnv } from "./harnesses/env.ts";
import { acquireFileLock, FileLockTimeoutError, lockPathFor } from "./lock.ts";
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

export async function openAgentRunner(
  harness: Harness,
  options: AgentRunnerOptions,
  seams: ExecutionSeams,
): Promise<AgentRunner> {
  if (harness.kind === "pi")
    throw new JigsError(
      "createAgentRunner cannot open a Pi harness: Pi has no AI SDK provider model. Run Pi with runAgent from #jigs/routines",
    );
  const target: HarnessTarget = { harness, cwd: options.cwd, resume: options.resume };
  const prepared = await prepareAgentRun(target, seams);
  const { driver } = prepared;
  try {
    if (driver.open === undefined) throw new JigsError(`the ${harness.kind} driver cannot run`);
    const opened = await driver.open(target, { metadata: options.run, env: prepared.env });
    let closing: Promise<void> | undefined;
    return {
      model: opened.model,
      sessionFrom: (result) =>
        extractAgentSession(harness, result.providerMetadata, driver.sessionPointer),
      close: () => {
        closing ??= opened.close().finally(() => prepared.release());
        return closing;
      },
    };
  } catch (err) {
    prepared.release();
    throw err;
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
export function createAgentRunner(
  harness: Harness,
  options: AgentRunnerOptions,
): Promise<AgentRunner> {
  return openAgentRunner(harness, options, executionSeams);
}
