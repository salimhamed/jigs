// The workflow side of the agent step: a plain function that plans a
// fully-serializable wire, hands it to the step function the factory injects,
// and zod-parses the recorded raw output back into the typed AgentStepResult.
// Memoization is the SDK's positional replay — no author-supplied keys
// anywhere.
//
// ../../steps/agent/run-agent.ts is the step side of the same split.

import type { FailedCheck } from "../../checks/catalog.ts";
import { type AgentStepConfig, type AgentWire, buildAgentWire, parseOutput } from "./plan.ts";
import type { AgentStepResult } from "./result.ts";
import { resumeFailed } from "./resume-or-rebuild.ts";

// Thrown workflow-side, never inside the step: a step's rejection is rebuilt
// from its message alone, so a JIT failure crosses the boundary as a returned
// value and becomes an error here, where `instanceof` still means something.
//
// The failures travel as the catalog's own records. A caller that has to write
// them for a human reads the fields; only the message is a rendering, and it
// exists because an Error has to have one.
export class JitCheckError extends Error {
  readonly failures: FailedCheck[];

  constructor(failures: FailedCheck[]) {
    super(failures.map(({ label, reason }) => `${label}: ${reason}`).join("\n"));
    this.name = "JitCheckError";
    this.failures = failures;
  }
}

/** The factory's `"use step"` wrapper around `executeAgent`. */
export type ExecuteAgentStep = (
  wire: AgentWire,
) => Promise<AgentStepResult | { jitFailure: FailedCheck[] } | { resumeFailed: string }>;

// Where the step's returned markers become errors: workflow-side, so no
// retries are spent and `instanceof` still means something to the caller.
export function unwrapAgentStep(result: Awaited<ReturnType<ExecuteAgentStep>>): AgentStepResult {
  if ("jitFailure" in result) throw new JitCheckError(result.jitFailure);
  // Same shape, same reason as the JIT marker, but the error it becomes is
  // ./resume-or-rebuild's business: only the fallback there may recognize it.
  if ("resumeFailed" in result) resumeFailed(result.resumeFailed);
  return result;
}

export async function runAgent<T = undefined>(
  config: AgentStepConfig<T>,
  executeAgent: ExecuteAgentStep,
): Promise<AgentStepResult<T>> {
  const wire = buildAgentWire(config);
  const result = unwrapAgentStep(await executeAgent(wire));
  return { ...result, output: parseOutput(config.output, result.output) };
}
