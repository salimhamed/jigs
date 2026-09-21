import { experimental_evaluate, generateText, jsonSchema, Output, type OutputInterface } from "ai";
import type { ExecuteAgentStep } from "../../blocks/agents/agent.ts";
import type { HarnessKind } from "../../blocks/agents/harness-config.ts";
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
import { withCodexAppServer } from "./drivers/codex-support.ts";
import { type DriverDependencies, driverFor, type ExecutorGeneration } from "./drivers/index.ts";
import type { Driver } from "./drivers/types.ts";
import { ensureManagedCodexHome } from "./harnesses/codex-home.ts";
import { scrubbedEnv } from "./harnesses/env.ts";
import { executePi } from "./harnesses/pi.ts";
import { ensureManagedPiHome } from "./harnesses/pi-home.ts";
import { FileLockTimeoutError, lockPathFor, withFileLock } from "./lock.ts";

/** Injectable provider and environment operations used by agent execution. */
export interface AgentExecutionDependencies extends DriverDependencies {
  jitFailures(wire: AgentRequest): Promise<FailedCheck[] | undefined>;
}

/** Production dependencies for executing harness requests. */
export const defaultAgentExecutionDependencies: AgentExecutionDependencies = {
  generateText: (options) => generateText(options),
  evaluate: (options) => experimental_evaluate(options),
  ensureCodexHome: (runId) => ensureManagedCodexHome(runId),
  ensurePiHome: (runId, source) => ensureManagedPiHome(runId, source),
  executePi,
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

function callSiteChecks(driver: Driver<HarnessKind>, wire: AgentRequest) {
  const kindOnlyIds = new Set(
    [...driver.runtimeChecks(), ...driver.authChecks()].map((check) => check.id),
  );
  return [...driver.runtimeChecks(wire), ...driver.authChecks(wire)].filter(
    (check) => !kindOnlyIds.has(check.id),
  );
}

/** Run or ask an agent harness, checking worktree requirements before a run. */
export async function executeAgent(
  wire: AgentRequest,
  metadata: RunMetadata,
  deps: AgentExecutionDependencies = defaultAgentExecutionDependencies,
): ReturnType<ExecuteAgentStep> {
  const driver = driverFor(wire.harness.kind);
  if (driver === undefined) throw new JigsError(`no driver is registered for ${wire.harness.kind}`);
  const isRun = wire.cwd !== undefined;
  if (!isRun) {
    if (driver.ask === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot ask`);
    const callSiteReport = await runChecks(callSiteChecks(driver, wire));
    if (!callSiteReport.ok) throw new JigsError(formatFailures(callSiteReport));
    const generation = await driver.ask(wire, {
      metadata,
      deps,
      env: scrubbedEnv(driver.envAllowlist(wire)),
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
  const run = driver.run;
  if (run === undefined) throw new JigsError(`the ${wire.harness.kind} driver cannot run`);
  const callSiteReport = await runChecks(callSiteChecks(driver, wire));
  if (!callSiteReport.ok) throw new JigsError(formatFailures(callSiteReport));

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
