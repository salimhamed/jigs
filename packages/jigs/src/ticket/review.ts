// The shipped ticket-review block: one agent step that restates the ticket
// into a brief and issues a proceed / needs-human verdict, looping until it
// proceeds. jigs core still validates nothing — this block is optional, and
// invocation is approval.

import { z } from "zod";
import { interpolate, ticketReviewPrompt } from "../prompts/index.ts";
import type { AgentFn, HarnessConfig } from "../steps/index.ts";
import type { TicketClaim } from "../suspension/claim.ts";
import type { NeedsHumanFn } from "../suspension/needs-human.ts";
import { renderSnapshot, type TicketSnapshot } from "./snapshot.ts";

// strictObject so the harness's native structured output carries
// additionalProperties:false and a malformed verdict throws at the
// workflow-side parse rather than degrading into a guess.
export const ticketReviewVerdict = z.strictObject({
  verdict: z.enum(["proceed", "needs-human"]),
  brief: z.string().min(1),
  findings: z.array(z.string()),
});

/**
 * What a ticket review hands the builder: the brief plus the snapshot it
 * was written from. Both travel together on purpose — the ticket is
 * authoritative wherever the two conflict, and review or verify steps judge
 * the work against the snapshot's acceptance criteria, never against the
 * brief, so a re-planning agent cannot move the goalposts.
 */
export type Handoff = {
  brief: string;
  snapshot: TicketSnapshot;
};

export interface TicketReviewOptions {
  agent: AgentFn;
  needsHuman: NeedsHumanFn;
  // Re-read between rounds: a human's reply lands on the ticket, not in the
  // verdict, so a round that does not re-snapshot reviews the same words again.
  fetchSnapshot: (issueId: string) => Promise<TicketSnapshot>;
  claim: TicketClaim;
  // The block never fetches the first one: the pipeline body owns
  // per-activation snapshots and passes one in, which is what keeps every step
  // in an activation reading the same copy.
  snapshot: TicketSnapshot;
  harness: HarnessConfig;
  cwd: string;
}

export async function ticketReview(
  options: TicketReviewOptions,
): Promise<Handoff> {
  const { agent, needsHuman, fetchSnapshot } = options;
  let snapshot = options.snapshot;

  for (;;) {
    const review = await agent({
      harness: options.harness,
      cwd: options.cwd,
      prompt: interpolate(ticketReviewPrompt, {
        TICKET: renderSnapshot(snapshot),
      }),
      output: ticketReviewVerdict,
    });
    const { verdict, brief, findings } = review.output;
    console.log(
      `[ticketReview] ${snapshot.identifier} verdict=${verdict} findings=${findings.length}`,
    );
    if (verdict === "proceed") return { brief, snapshot };

    // findings only: the comment is for the human and the record, never the
    // data path — the brief the next round writes is what reaches the builder.
    await needsHuman(options.claim, "ticket review needs a human", {
      findings,
    });
    snapshot = await fetchSnapshot(snapshot.id);
  }
}
