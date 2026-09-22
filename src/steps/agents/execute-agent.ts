import { experimental_evaluate, generateText, jsonSchema, Output, type OutputInterface } from "ai";
import type { ExecuteAgentStep } from "../../blocks/agents/agent.ts";
import type { AgentRequest } from "../../blocks/agents/plan.ts";
import { extractAgentSession, toModelResult } from "../../blocks/agents/result.ts";
import {
  type FailedCheck,
  failedChecks,
  formatFailures,
  JIT_TIMEOUT_MS,
  jitChecks,
  runChecks,
} from "../../checks/index.ts";
import { JigsError } from "../../errors.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import {
  type DriverDependencies,
  type DriverResolver,
  driverFor,
  type ExecutorGeneration,
} from "./drivers/index.ts";
import { scrubbedEnv } from "./harnesses/env.ts";
import { FileLockTimeoutError, lockPathFor, withFileLock } from "./lock.ts";
import { AgentSessionError } from "./session-error.ts";

/** Injectable provider and environment operations used by agent execution. */
export interface AgentExecutionDependencies extends DriverDependencies {
  resolveDriver: DriverResolver;
  jitFailures(wire: AgentRequest): Promise<FailedCheck[] | undefined>;
}

/** Production dependencies for executing harness requests. */
export const defaultAgentExecutionDependencies: AgentExecutionDependencies = {
  generateText: (options) => generateText(options),
  evaluate: (options) => experimental_evaluate(options),
  resolveDriver: driverFor,
  jitFailures: async (wire) => {
    const report = await runChecks(jitChecks(wire), JIT_TIMEOUT_MS);
    return report.ok ? undefined : failedChecks(report);
  },
};

export function outputSpec(
  schema: Record<string, unknown> | undefined,
): OutputInterface<unknown, unknown, never> | undefined {
  return schema === undefined ? undefined : Output.object({ schema: jsonSchema<unknown>(schema) });
}

const LOCK_STALE_MS = 4 * 60 * 60_000 + 60_000;

/** Run or ask an agent harness, checking worktree requirements before a run. */
export async function executeAgent(
  wire: AgentRequest,
  metadata: RunMetadata,
  deps: AgentExecutionDependencies = defaultAgentExecutionDependencies,
): ReturnType<ExecuteAgentStep> {
  const driver = deps.resolveDriver(wire.harness.kind);
  if (driver === undefined) throw new JigsError(`no driver is registered for ${wire.harness.kind}`);
  const isRun = wire.cwd !== undefined;
  if (!isRun) {
    if (driver.ask === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot ask`);
    const requestReport = await runChecks(driver.requestChecks(wire));
    if (!requestReport.ok) throw new JigsError(formatFailures(requestReport));
    const generation = await driver.ask(wire, {
      metadata,
      deps,
      env: scrubbedEnv(driver.envAllowlist(wire)),
      output: outputSpec(wire.outputSchema),
    });
    return toModelResult(
      generation,
      wire.outputSchema === undefined ? undefined : generation.output,
    );
  }

  if (wire.resume !== undefined && wire.resume.harness !== wire.harness.kind) {
    return {
      resumeFailed: `session ${wire.resume.id} was recorded on the ${wire.resume.harness} harness and this step runs on ${wire.harness.kind}`,
    };
  }
  const run = driver.run;
  if (run === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot run`);
  const requestReport = await runChecks(driver.requestChecks(wire));
  if (!requestReport.ok) throw new JigsError(formatFailures(requestReport));
  const jitFailure = await deps.jitFailures(wire);
  if (jitFailure !== undefined) return { jitFailure };

  try {
    return await withFileLock(
      lockPathFor(wire.cwd, "agent-step"),
      async () => {
        let generation: ExecutorGeneration;
        try {
          generation = await run(wire, {
            metadata,
            deps,
            env: scrubbedEnv(driver.envAllowlist(wire)),
            output: outputSpec(wire.outputSchema),
          });
        } catch (err) {
          if (wire.resume === undefined || !(err instanceof AgentSessionError)) throw err;
          return { resumeFailed: String(err) };
        }
        const session = extractAgentSession(
          wire.harness.kind,
          generation.providerMetadata,
          driver.sessionPointer,
        );
        return {
          ...toModelResult(
            generation,
            wire.outputSchema === undefined ? undefined : generation.output,
          ),
          ...(session === undefined ? {} : { session }),
        };
      },
      { timeoutMs: 0, staleMs: LOCK_STALE_MS },
    );
  } catch (err) {
    if (err instanceof FileLockTimeoutError)
      throw new Error(
        `an agent is already running in ${wire.cwd} — refusing to start a second one in the same worktree`,
      );
    throw err;
  }
}

export type { ExecutorGeneration } from "./drivers/index.ts";
