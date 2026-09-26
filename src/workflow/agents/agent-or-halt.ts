// A JIT check failure is a needs-human halt, never a terminal failure: the
// repair goes to the ticket through the claim channel, the run suspends
// keeping its worktree, and the step re-runs from zero once a human replies.
// Late discovery costs a pause, never a relaunch.

import type { TicketClaim } from "../linear/claim.ts";
import type { HaltForHumanFn } from "../linear/halt-for-human.ts";
import { JitCheckError } from "./agent.ts";
import type { RunAgentFn } from "./agent-session.ts";
import type { RunAgentOptions } from "./plan.ts";
import type { AgentResult } from "./result.ts";

/** Bound operations used to turn agent startup failures into human halts. */
export interface RunAgentOrHaltDependencies {
  runAgent: RunAgentFn;
  haltForHuman: HaltForHumanFn;
}

/** Who else the repair request mentions on the ticket. */
export interface RunAgentOrHaltOptions {
  /** More people, by Linear email, beyond the operator (or the creator) and the assignee. */
  mention?: string[] | undefined;
}

// Unbounded on purpose: the halt is a pause the human ends, and each loop
// iteration is a fresh step slot, which is what makes the retry a re-run
// from zero rather than a replay of the memoized failure.
/** Run an agent, pausing on its ticket until a human repairs failed tool checks. */
export async function runAgentOrHalt<T = undefined>(
  claim: TicketClaim,
  config: RunAgentOptions<T>,
  deps: RunAgentOrHaltDependencies,
  options: RunAgentOrHaltOptions = {},
): Promise<AgentResult<T>> {
  for (;;) {
    try {
      return await deps.runAgent(config);
    } catch (err) {
      if (!(err instanceof JitCheckError)) throw err;
      await deps.haltForHuman(claim, {
        headline: `jigs could not start a step on **${claim.identifier}** because a check failed.`,
        where: "starting a step",
        // The comment is not a console: one failure, one plain line.
        notes: err.failures.map(({ label, reason, repair }) => `${label}: ${reason}. ${repair}`),
        onReply: "retry",
        mention: options.mention,
      });
    }
  }
}
