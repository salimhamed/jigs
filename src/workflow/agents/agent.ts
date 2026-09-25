// The workflow half of the agent step: a plain function that plans a
// fully-serializable wire, hands it to the step function the factory injects,
// and zod-parses the recorded raw output back into the typed AgentResult.
// Memoization is the SDK's positional replay — no author-supplied keys
// anywhere.
//
// ../../steps/agents/execute-agent.ts is the step side of the same split.

import type { FailedCheck } from "../../checks/catalog.ts";
import { resumeFailed } from "./agent-session.ts";
import { type AgentRequest, buildAgentRequest, parseOutput, type RunAgentOptions } from "./plan.ts";
import type { AgentResult } from "./result.ts";

// Thrown in the workflow, never inside the step: a step's rejection is rebuilt
// from its message alone, so a JIT failure crosses the boundary as a returned
// value and becomes an error here, where `instanceof` still means something.
//
// The failures travel as the catalog's own records. A caller that has to write
// them for a human reads the fields; only the message is a rendering, and it
// exists because an Error has to have one.
/**
 * A failed just-in-time tool check, with repair details for each failure.
 *
 * @group Factory plumbing
 */
export class JitCheckError extends Error {
  readonly failures: FailedCheck[];

  constructor(failures: FailedCheck[]) {
    super(failures.map(({ label, reason }) => `${label}: ${reason}`).join("\n"));
    this.name = "JitCheckError";
    this.failures = failures;
  }
}

/**
 * The factory's `"use step"` wrapper around `executeAgent`.
 *
 * @group Factory plumbing
 */
export type ExecuteAgentStep = (
  wire: AgentRequest,
) => Promise<AgentResult | { jitFailure: FailedCheck[] } | { resumeFailed: string }>;

// Where the step's returned markers become errors: in the workflow, so no
// retries are spent and `instanceof` still means something to the caller.
/**
 * Convert returned execution failure markers into errors the workflow throws.
 *
 * @group Factory plumbing
 */
export function unwrapAgentStep(result: Awaited<ReturnType<ExecuteAgentStep>>): AgentResult {
  if ("jitFailure" in result) throw new JitCheckError(result.jitFailure);
  // Same shape, same reason as the JIT marker, but the error it becomes is
  // ./agent-session's business: only the fallback there may recognize it.
  if ("resumeFailed" in result) resumeFailed(result.resumeFailed);
  return result;
}

/** Run an agent through a durable wrapper and parse its optional structured output. */
export async function runAgent<T = undefined>(
  config: RunAgentOptions<T>,
  executeAgent: ExecuteAgentStep,
): Promise<AgentResult<T>> {
  const wire = buildAgentRequest(config);
  const result = unwrapAgentStep(await executeAgent(wire));
  return { ...result, output: parseOutput(config.output, result.output) };
}
