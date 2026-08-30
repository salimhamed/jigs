// The step side of agent() and ask(): what the factory's "use step" wrappers
// delegate to. Everything here reaches node builtins through jigs, so this
// module must only ever be imported from inside a step body — a workflow-side
// import of it fails the build loudly, which is the point of keeping it apart
// from ./index.

import {
  formatFailures,
  JIT_TIMEOUT_MS,
  jitChecks,
  runChecks,
} from "jigs/checks";
import type {
  AgentStepResult,
  AgentWire,
  AskWire,
  StepResult,
} from "jigs/steps";
import { executeAgentStep, executeAskStep } from "jigs/steps/execute";

export async function runAgent(
  wire: AgentWire,
  runKey: string,
): Promise<
  AgentStepResult | { jitFailure: string } | { resumeFailed: string }
> {
  // JIT checks first — this is the last honest moment before agent turns
  // get burned, and the servers only exist now that the body built them.
  const report = await runChecks(jitChecks(wire), JIT_TIMEOUT_MS);
  // Returned, not thrown: a failed step's rejection is rebuilt from its
  // message, and a value is not a step failure, so no retries either.
  if (!report.ok) return { jitFailure: formatFailures(report) };
  return executeAgentStep(wire, runKey);
}

export async function runAsk(
  wire: AskWire,
  runKey: string,
): Promise<StepResult> {
  return executeAskStep(wire, runKey);
}
