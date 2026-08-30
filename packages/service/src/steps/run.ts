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
import type { AgentWire, AskWire, StepResult } from "jigs/steps";
import { executeAgentStep, executeAskStep } from "jigs/steps/execute";
// Type-only, so it is erased and no workflow-side module is pulled in here.
// The wrapper type is the one declaration of what crosses the step boundary.
import type { RunAgentStep } from "./index";

export async function runAgent(
  wire: AgentWire,
  runKey: string,
): ReturnType<RunAgentStep> {
  // JIT checks first — this is the last honest moment before agent turns
  // get burned, and the servers only exist now that the body built them.
  const report = await runChecks(jitChecks(wire), JIT_TIMEOUT_MS);
  // Returned, not thrown: a failed step's rejection is rebuilt from its
  // message, and a value is not a step failure, so no retries either.
  if (!report.ok) return { jitFailure: formatFailures(report) };
  return executeAgentStep(wire, runKey);
}

// A passthrough today, so the factory's ask wrapper imports this module
// rather than jigs internals.
export async function runAsk(
  wire: AskWire,
  runKey: string,
): Promise<StepResult> {
  return executeAskStep(wire, runKey);
}
