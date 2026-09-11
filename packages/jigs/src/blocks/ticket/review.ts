// The shipped ticket-review block: one agent step that restates the ticket
// into a brief and issues a proceed / needs-human verdict, looping until it
// proceeds. jigs core still validates nothing — this block is optional, and
// invocation is approval.

import { z } from "zod";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { TicketClaim } from "./claim.ts";
import { type HaltForHumanFn, haltQuestion } from "./halt-for-human.ts";
import { renderSnapshot, type TicketSnapshot } from "./snapshot.ts";

const TICKET_REVIEW = "ticket-review";

// strictObject so the harness's native structured output carries
// additionalProperties:false and a malformed verdict throws at the
// workflow-side parse rather than degrading into a guess.
export const ticketReviewVerdict = z.strictObject({
  verdict: z.enum(["proceed", "needs-human"]),
  brief: z.string().min(1),
  // What the ticket is about, in plain words, for whoever reads the comment.
  about: z.string(),
  questions: z.array(haltQuestion),
  assumptions: z.array(z.string()),
});

/** What a ticket review posts when it proceeds without asking anything. */
export type TicketNote = {
  identifier: string;
  assumptions: string[];
};

/**
 * Posting a note on the ticket that asks for nothing and suspends nothing.
 * Declared here rather than written as `typeof postTicketNote` for the same
 * reason the halt's step contracts are: the block side owns the contract.
 */
export type PostTicketNote = (
  issueId: string,
  note: TicketNote,
) => Promise<void>;

/**
 * What a ticket review hands the builder: the brief plus the snapshot it
 * was written from. Both travel together on purpose — the ticket is
 * authoritative wherever the two conflict, and review or verify steps judge
 * the work against the snapshot's acceptance criteria, never against the
 * brief, so a re-planning agent cannot move the goalposts.
 *
 * `assumptions` is what the review decided for itself rather than asked
 * about. It is posted to the ticket, so a human can still correct it.
 */
export type Handoff = {
  brief: string;
  snapshot: TicketSnapshot;
  assumptions: string[];
};

export interface ReviewTicketOptions {
  agent: AgentFn;
  haltForHuman: HaltForHumanFn;
  postNote: PostTicketNote;
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
  // Names a registered prompt; defaults to the one jigs ships.
  prompt?: string;
}

export async function reviewTicket(
  options: ReviewTicketOptions,
): Promise<Handoff> {
  const { agent, haltForHuman, fetchSnapshot, postNote } = options;
  let snapshot = options.snapshot;

  for (;;) {
    const review = await agent({
      harness: options.harness,
      cwd: options.cwd,
      prompt: {
        name: options.prompt ?? TICKET_REVIEW,
        data: { TICKET: renderSnapshot(snapshot) },
      },
      output: ticketReviewVerdict,
    });
    const { verdict, brief, about, questions, assumptions } = review.output;
    console.log(
      `[reviewTicket] ${snapshot.identifier} verdict=${verdict} questions=${questions.length} assumptions=${assumptions.length}`,
    );
    if (verdict === "proceed") {
      // A note, not a halt: the run keeps going, and the comment says plainly
      // that a correction now lands on the pull request instead.
      if (assumptions.length > 0) {
        await postNote(snapshot.id, {
          identifier: snapshot.identifier,
          assumptions,
        });
      }
      return { brief, snapshot, assumptions };
    }

    // The questions only: the comment is for the human and the record, never
    // the data path — the brief the next round writes is what reaches the
    // builder.
    await haltForHuman(options.claim, {
      headline: `jigs paused work on **${snapshot.identifier}** and needs your answers before it writes any code.`,
      ...(about === "" ? {} : { about }),
      questions,
      onReply: "continue",
    });
    snapshot = await fetchSnapshot(snapshot.id);
  }
}
