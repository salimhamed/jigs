// A JIT check failure is a needs-human halt, never a terminal failure (ADR
// 0010): the repair goes to the ticket through the claim channel, the run
// suspends keeping its worktree, and the step re-runs from zero once a human
// replies. Late discovery costs a pause, never a relaunch.

import type { AgentStepConfig, AgentStepResult } from "jigs/steps";
import type { TicketClaim } from "../suspension/claim";
import { needsHuman } from "../suspension/needs-human";
import { agent, JitCheckError } from "./index";

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
      if (!(err instanceof JitCheckError)) throw err;
      await deps.needsHuman(claim, err.failures);
    }
  }
}
