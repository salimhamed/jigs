// A JIT check failure is a needs-human halt, never a terminal failure: the
// repair goes to the ticket through the claim channel, the run suspends
// keeping its worktree, and the step re-runs from zero once a human replies.
// Late discovery costs a pause, never a relaunch.

import type { TicketClaim } from "../ticket/claim.ts";
import type { HaltForHumanFn } from "../ticket/halt-for-human.ts";
import { JitCheckError } from "./agent.ts";
import type { AgentStepConfig } from "./plan.ts";
import type { AgentStepResult } from "./result.ts";
import type { AgentFn } from "./resume-or-rebuild.ts";

export interface AgentOrHaltDeps {
  agent: AgentFn;
  haltForHuman: HaltForHumanFn;
}

// The catalog writes a failure as "label: reason" and its repair on an
// arrow-prefixed second line. That reads as a console message, and the comment
// is not a console: one failure becomes one plain line, repair included.
export function checkFailureNotes(failures: string): string[] {
  const notes: string[] = [];
  for (const line of failures.split("\n")) {
    const repair = line.match(/^\s*→\s*(.*)$/);
    const previous = notes.at(-1);
    if (repair !== null && previous !== undefined) {
      notes[notes.length - 1] = `${previous} — ${repair[1]}`;
      continue;
    }
    const text = line.trim();
    if (text !== "") notes.push(text);
  }
  return notes;
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
      await deps.haltForHuman(claim, {
        headline: `jigs could not start a step on **${claim.identifier}** because a check failed.`,
        notes: checkFailureNotes(err.message),
        onReply: "retry",
      });
    }
  }
}
