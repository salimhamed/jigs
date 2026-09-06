// The implement ⇄ review block (ADR 0003): the circuit breaker is a plain loop
// bound, and the halt it ends on is a pause a human ends — never a terminal
// state, so nothing the builder produced is discarded.
//
// The code-review call interpolates the ticket and the branch point and
// nothing else. The reviewer judges the change against the ticket's acceptance
// criteria, so the brief a re-planning agent wrote is deliberately out of its
// scope — the prompt says so, and this call site is what makes it true.

import { z } from "zod";
import {
  codeReviewPrompt,
  implementPrompt,
  interpolate,
} from "../prompts/index.ts";
import type { AgentFn, AgentSession, HarnessConfig } from "../steps/index.ts";
import type { TicketClaim } from "../suspension/claim.ts";
import type { NeedsHumanFn } from "../suspension/needs-human.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";

// strictObject for the same reason ticketReviewVerdict is: the harness's
// native structured output carries additionalProperties:false, and a malformed
// verdict throws at the workflow-side parse rather than degrading into a guess.
export const codeReviewVerdict = z.strictObject({
  verdict: z.enum(["approved", "changes-requested"]),
  findings: z.array(z.string()),
});

export interface ImplementAndReviewOptions {
  agent: AgentFn;
  needsHuman: NeedsHumanFn;
  claim: TicketClaim;
  handoff: Handoff;
  harness: HarnessConfig;
  cwd: string;
  baseSha: string;
}

export type ImplementAndReviewResult = {
  session?: AgentSession;
  cycles: number;
};

const MAX_REVIEW_CYCLES = 3;
const FIRST_PASS = "_(first pass)_";

function renderFindings(findings: string[]): string {
  return findings.length === 0
    ? "_(the reviewer requested changes without naming any)_"
    : findings.map((finding) => `- ${finding}`).join("\n");
}

export async function implementAndReview(
  options: ImplementAndReviewOptions,
): Promise<ImplementAndReviewResult> {
  const { agent, needsHuman } = options;
  const ticket = renderSnapshot(options.handoff.snapshot);
  let session: AgentSession | undefined;
  let review = FIRST_PASS;
  let findings: string[] = [];
  let cycles = 0;

  // Outer loop: the needs-human halt is a pause, so a human's reply becomes
  // the next round's findings and the run is never stranded.
  for (;;) {
    for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle += 1) {
      cycles += 1;
      const build = await agent({
        harness: options.harness,
        cwd: options.cwd,
        prompt: interpolate(implementPrompt, {
          TICKET: ticket,
          BRIEF: options.handoff.brief,
          REVIEW: review,
        }),
      });
      // The builder's session pointer, captured where the builder ran.
      session = build.session ?? session;

      const verdict = await agent({
        harness: options.harness,
        cwd: options.cwd,
        prompt: interpolate(codeReviewPrompt, {
          TICKET: ticket,
          BASE_SHA: options.baseSha,
        }),
        output: codeReviewVerdict,
      });
      findings = verdict.output.findings;
      console.log(
        `[implementAndReview] cycle ${cycle}/${MAX_REVIEW_CYCLES} verdict=${verdict.output.verdict} findings=${findings.length}`,
      );
      if (verdict.output.verdict === "approved") {
        return {
          ...(session !== undefined ? { session } : {}),
          cycles,
        };
      }
      review = renderFindings(findings);
    }

    const reply = await needsHuman(
      options.claim,
      `review loop hit its ${MAX_REVIEW_CYCLES}-cycle bound`,
      { findings },
    );
    review = reply.body;
  }
}
