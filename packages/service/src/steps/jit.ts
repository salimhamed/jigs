// A JIT check failure is a needs-human halt, never a terminal failure (ADR
// 0010): the repair goes to the ticket through the claim channel, the run
// suspends keeping its worktree, and the step re-runs from zero once a human
// replies. Late discovery costs a pause, never a relaunch.

import type { AgentStepConfig, AgentStepResult } from "jigs/steps";
import type { TicketClaim } from "../suspension/claim";
import { needsHuman } from "../suspension/needs-human";
import { agent } from "./index";

// Only an error's message crosses the step boundary — the runtime rebuilds a
// failed step's rejection from the string alone — so the marker has to be in
// the text.
export const JIT_FAILURE_PREFIX = "jigs JIT check failed:\n";

// Structural, never `instanceof Error`: the workflow body runs in its own vm
// realm, so the rejection the runtime hands it fails every cross-realm
// instanceof and String(err) prefixes the class name onto the message.
function messageOf(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
}

export function jitFailureText(err: unknown): string | null {
  const message = messageOf(err);
  return message.startsWith(JIT_FAILURE_PREFIX)
    ? message.slice(JIT_FAILURE_PREFIX.length)
    : null;
}

export interface AgentOrHaltDeps {
  agent: typeof agent;
  needsHuman: typeof needsHuman;
}

// Unbounded on purpose: the halt is a pause the human ends, and each loop
// iteration is a fresh step slot, which is what makes the retry a re-run
// from zero rather than a replay of the memoized failure.
export async function agentOrHalt<T = undefined>(
  claim: TicketClaim,
  config: AgentStepConfig<T>,
  deps: AgentOrHaltDeps = { agent, needsHuman },
): Promise<AgentStepResult<T>> {
  for (;;) {
    try {
      return await deps.agent(config);
    } catch (err) {
      const text = jitFailureText(err);
      if (text === null) throw err;
      await deps.needsHuman(claim, text);
    }
  }
}
