import { generateText, jsonSchema, Output, type OutputInterface } from "ai";
import type { ExecuteAgentStep } from "../../blocks/agents/agent.ts";
import type { AgentRequest } from "../../blocks/agents/plan.ts";
import { extractAgentSession, toModelResult } from "../../blocks/agents/result.ts";
import {
  type FailedCheck,
  failedChecks,
  JIT_TIMEOUT_MS,
  jitChecks,
  runChecks,
} from "../../checks/index.ts";
import { JigsError } from "../../errors.ts";
import type { RunMetadata } from "../runtime/run-context.ts";
import { withCodexAppServer } from "./drivers/codex-support.ts";
import { type DriverDependencies, drivers, type ExecutorGeneration } from "./drivers/index.ts";
import { ensureManagedCodexHome } from "./harnesses/codex-home.ts";
import { scrubbedEnv } from "./harnesses/env.ts";
import { FileLockTimeoutError, lockPathFor, withFileLock } from "./lock.ts";

/** Injectable provider and environment operations used by agent execution. */
export interface AgentExecutionDependencies extends DriverDependencies {
  jitFailures(wire: AgentRequest): Promise<FailedCheck[] | undefined>;
}

/** Production dependencies for executing harness requests. */
export const defaultAgentExecutionDependencies: AgentExecutionDependencies = {
  generateText: (options) => generateText(options),
  ensureCodexHome: (runId) => ensureManagedCodexHome(runId),
  withCodexAppServer,
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

function driverFor(kind: string) {
  const driver = (drivers as Record<string, (typeof drivers)[keyof typeof drivers] | undefined>)[
    kind
  ];
  if (driver === undefined) throw new JigsError(`no driver is registered for ${kind}`);
  return driver;
}

/** Run or ask an agent harness, checking worktree requirements before a run. */
export async function executeAgent(
  wire: AgentRequest,
  metadata: RunMetadata,
  deps: AgentExecutionDependencies = defaultAgentExecutionDependencies,
): ReturnType<ExecuteAgentStep> {
  const driver = driverFor(wire.harness.kind);
  const isRun = wire.cwd !== undefined;
  if (!isRun) {
    if (driver.ask === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot ask`);
    const generation = await driver.ask(wire, {
      metadata,
      deps,
      env: scrubbedEnv(driver.envAllowlist),
      output: outputSpec(wire.outputSchema),
    });
    const costUsd = driver.cost(generation);
    return toModelResult(
      costUsd === undefined ? generation : { ...generation, costUsd },
      wire.outputSchema === undefined ? undefined : generation.output,
    );
  }

  const jitFailure = await deps.jitFailures(wire);
  if (jitFailure !== undefined) return { jitFailure };
  if (wire.resume !== undefined && wire.resume.harness !== wire.harness.kind) {
    return {
      resumeFailed: `session ${wire.resume.id} was recorded on the ${wire.resume.harness} harness and this step runs on ${wire.harness.kind}`,
    };
  }
  if (driver.run === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot run`);

  try {
    return await withFileLock(
      lockPathFor(wire.cwd, "agent-step"),
      async () => {
        let generation: ExecutorGeneration;
        try {
          generation = await driver.run(wire, {
            metadata,
            deps,
            env: scrubbedEnv(driver.envAllowlist),
            output: outputSpec(wire.outputSchema),
          });
        } catch (err) {
          if (wire.resume === undefined) throw err;
          return { resumeFailed: String(err) };
        }
        const costUsd = driver.cost(generation);
        const session = extractAgentSession(
          wire.harness.kind,
          generation.providerMetadata,
          driver.sessionPointer,
        );
        return {
          ...toModelResult(
            costUsd === undefined ? generation : { ...generation, costUsd },
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
