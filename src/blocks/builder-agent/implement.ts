// The implement ⇄ review block: the circuit breaker is a plain loop bound, and
// the halt it ends on is a pause a human ends — never a terminal state, so
// nothing the builder produced is discarded.
//
// The human's reply becomes the builder's next round of instructions verbatim,
// which is why the question says so: a person who knows the builder reads their
// words as written writes direction rather than a question back.
//
// The code-review call renders the ticket and the branch point and nothing
// else. The reviewer judges the change against the ticket's acceptance
// criteria, so the brief a re-planning agent wrote is deliberately out of its
// scope — the prompt says so, and this call site is what makes it true.

import { z } from "zod";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { TicketClaim } from "../ticket/claim.ts";
import type { Halt, HaltForHumanFn } from "../ticket/halt-for-human.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";
import { type CodeReviewPrompt, codeReviewPrompt } from "./code-review.prompt.ts";
import { type ImplementPrompt, implementPrompt } from "./implement.prompt.ts";

// strictObject for the same reason ticketReviewVerdict is: the harness's
// native structured output carries additionalProperties:false, and a malformed
// verdict throws at the workflow-side parse rather than degrading into a guess.
export const codeReviewVerdict = z.strictObject({
  verdict: z.enum(["approved", "changes-requested"]),
  findings: z.array(z.string()),
});

export interface ImplementOptions {
  agent: AgentFn;
  haltForHuman: HaltForHumanFn;
  claim: TicketClaim;
  handoff: Handoff;
  harness: HarnessConfig;
  cwd: string;
  baseSha: string;
  // The two sets of words this block speaks, which the factory owns: its own
  // functions in place of the ones shipped beside this block.
  implementPrompt?: ImplementPrompt;
  codeReviewPrompt?: CodeReviewPrompt;
}

export type ImplementResult = {
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

/** Build the change and repeat code review until it is approved. */
export async function implementUntilCodeReviewApproves(
  options: ImplementOptions,
): Promise<ImplementResult> {
  const { agent, haltForHuman } = options;
  const renderImplement = options.implementPrompt ?? implementPrompt;
  const renderCodeReview = options.codeReviewPrompt ?? codeReviewPrompt;
  const { identifier } = options.handoff.snapshot;
  const ticket = renderSnapshot(options.handoff.snapshot);
  let session: AgentSession | undefined;
  let review = FIRST_PASS;
  let findings: string[] = [];
  let cycles = 0;

  // Outer loop: the needs-human halt is a pause, so a human's reply becomes
  // the next round's instructions and the run is never stranded.
  for (;;) {
    for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle += 1) {
      cycles += 1;
      const build = await agent({
        harness: options.harness,
        cwd: options.cwd,
        prompt: renderImplement({
          ticket,
          brief: options.handoff.brief,
          review,
        }),
      });
      // The builder's session pointer, captured where the builder ran.
      session = build.session ?? session;

      const verdict = await agent({
        harness: options.harness,
        cwd: options.cwd,
        prompt: renderCodeReview({ ticket, baseSha: options.baseSha }),
        output: codeReviewVerdict,
      });
      findings = verdict.output.findings;
      console.log(
        `[implementUntilCodeReviewApproves] cycle ${cycle}/${MAX_REVIEW_CYCLES} verdict=${verdict.output.verdict} findings=${findings.length}`,
      );
      if (verdict.output.verdict === "approved") {
        return {
          ...(session !== undefined ? { session } : {}),
          cycles,
        };
      }
      review = renderFindings(findings);
    }

    const halt: Halt = {
      headline: `jigs paused work on **${identifier}**. The builder and the reviewer could not agree after ${MAX_REVIEW_CYCLES} rounds, and jigs needs you to decide how to proceed.`,
      where: "code review",
      notes: findings,
      questions: [
        {
          question: "How should the builder proceed?",
          context:
            "Reply with what the builder should change or do next. The builder will follow your words as written, so give it direction rather than a question.",
        },
      ],
      onReply: "continue",
    };

    const reply = await haltForHuman(options.claim, halt);
    review = reply.body;
  }
}
