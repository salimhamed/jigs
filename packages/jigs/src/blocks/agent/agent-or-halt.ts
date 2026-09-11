// A JIT check failure is a needs-human halt, never a terminal failure: the
// repair goes to the ticket through the claim channel, the run suspends
// keeping its worktree, and the step re-runs from zero once a human replies.
// Late discovery costs a pause, never a relaunch.

import type { TicketClaim } from "../ticket/claim.ts";
import type { NeedsHumanFn } from "../ticket/halt-for-human.ts";
import { JitCheckError } from "./agent.ts";
import type { AgentStepConfig } from "./plan.ts";
import type { AgentStepResult } from "./result.ts";
import type { AgentFn } from "./resume-or-rebuild.ts";

export interface AgentOrHaltDeps {
  agent: AgentFn;
  needsHuman: NeedsHumanFn;
}

// Unbounded on purpose: the halt is a pause the human ends, and each loop
// iteration is a fresh step slot, which is what makes the retry a re-run
// from zero rather than a replay of the memoized failure.
export async function agentOrHalt<T = undefined>(
  claim: TicketClaim,
  config: AgentStepConfig<T>,
  deps: AgentOrHaltDeps,
): Promise<AgentStepResult<T>> {
  for (;;) {
    try {
      return await deps.agent(config);
    } catch (err) {
      if (!(err instanceof JitCheckError)) throw err;
      await deps.needsHuman(claim, err.message);
    }
  }
}
