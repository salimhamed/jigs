// The shipped ticket-review jig (ADR 0002): one agent step that restates the
// ticket into a brief and issues a proceed / needs-human verdict. jigs core
// still validates nothing — this jig is optional, and invocation is approval.

import { interpolate, ticketReviewPrompt } from "@salimhamed/jigs/prompts";
import type { HarnessConfig } from "@salimhamed/jigs/steps";
import { z } from "zod";
import type { AgentFn } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import type { NeedsHumanFn } from "../suspension/needs-human";
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
  agent: AgentFn;
  needsHuman: NeedsHumanFn;
};

export interface TicketReviewOptions {
  claim: TicketClaim;
  // The jig never fetches: the pipeline body owns per-activation snapshots
  // and passes one in, which is what keeps every step in an activation
  // reading the same copy.
  snapshot: TicketSnapshot;
  harness: HarnessConfig;
  cwd: string;
}

export async function ticketReview(
  options: TicketReviewOptions,
  deps: TicketReviewDeps,
): Promise<TicketReviewResult> {
  const { claim, snapshot } = options;
  const prompt = interpolate(ticketReviewPrompt, {
    TICKET: renderSnapshot(snapshot),
  });

  const review = await deps.agent({
    harness: options.harness,
    cwd: options.cwd,
    // The reviewer's prompt asks it to inspect the checkout, and Bash is not
    // auto-approved below this mode — headless runs hang or degrade silently
    // without it, exactly as the implement/review loop documents. The codex
    // driver auto-approves at the executor regardless; this steers claude.
    permissionMode: "bypassPermissions",
    prompt,
    output: ticketReviewVerdict,
  });
  const { verdict, brief, findings } = review.output;
  console.log(
    `[ticketReview] ${snapshot.identifier} verdict=${verdict} findings=${findings.length}`,
  );

  if (verdict === "needs-human") {
    // findings only: the comment is for the human and the record, never the
    // data path — the brief reaches the builder in-process below.
    await deps.needsHuman(claim, "ticket review needs a human", { findings });
  }
  return { verdict, brief, findings, snapshot };
}
