// The shipped ticket-review jig (ADR 0002): one agent step that restates the
// ticket into a brief and issues a proceed / needs-human verdict. jigs core
// still validates nothing — this jig is optional, and invocation is approval.

import { interpolate, ticketReviewPrompt } from "jigs/prompts";
import type { HarnessConfig } from "jigs/steps";
import { z } from "zod";
import { agent } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import { needsHuman } from "../suspension/needs-human";
import { renderSnapshot, type TicketSnapshot } from "./snapshot";

// strictObject so the harness's native structured output carries
// additionalProperties:false and a malformed verdict throws at the
// workflow-side parse rather than degrading into a guess (ADR 0003).
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

export type TicketReviewResult = Handoff & {
  verdict: "proceed" | "needs-human";
  findings: string[];
};

// Workflow-side only: these never cross the step serialization boundary.
export type TicketReviewDeps = {
  agent: typeof agent;
  needsHuman: typeof needsHuman;
};

const realDeps: TicketReviewDeps = { agent, needsHuman };

export interface TicketReviewOptions {
  claim: TicketClaim;
  // The jig never fetches: the pipeline body owns per-activation snapshots
  // and passes one in, which is what keeps every step in an activation
  // reading the same copy.
  snapshot: TicketSnapshot;
  harness: HarnessConfig;
  cwd: string;
  // Interpolated with {{TICKET}} (the rendered snapshot); any other {{KEY}}
  // is left verbatim.
  prompt?: string;
}

export async function ticketReview(
  options: TicketReviewOptions,
  deps: TicketReviewDeps = realDeps,
): Promise<TicketReviewResult> {
  const { claim, snapshot } = options;
  const prompt = interpolate(options.prompt ?? ticketReviewPrompt, {
    TICKET: renderSnapshot(snapshot),
  });

  const review = await deps.agent({
    harness: options.harness,
    cwd: options.cwd,
    prompt,
    output: ticketReviewVerdict,
  });
  const { verdict, brief, findings } = review.output;

  if (verdict === "needs-human") {
    // findings only: the comment is for the human and the record, never the
    // data path — the brief reaches the builder in-process below.
    await deps.needsHuman(claim, "ticket review needs a human", { findings });
  }
  return { verdict, brief, findings, snapshot };
}
