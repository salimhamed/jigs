// The implement ⇄ review block: the circuit breaker is a plain loop bound, and
// the halt it ends on is a pause a human ends — never a terminal state, so
// nothing the builder produced is discarded.
//
// The human's reply is read, never pasted. A person answering a deadlocked
// review writes to a person, so an agent step turns that answer into either
// instructions the builder can act on or the next question to put back on the
// ticket. Pasting the raw words into the builder's prompt is what made a
// half-answer look like a decision.
//
// The code-review call interpolates the ticket and the branch point and
// nothing else. The reviewer judges the change against the ticket's acceptance
// criteria, so the brief a re-planning agent wrote is deliberately out of its
// scope — the prompt says so, and this call site is what makes it true.

import { z } from "zod";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { TicketClaim } from "../ticket/claim.ts";
import type { Halt, HaltForHumanFn } from "../ticket/halt-for-human.ts";
import { haltQuestion } from "../ticket/halt-for-human.ts";
import type { Handoff } from "../ticket/review.ts";
import { renderSnapshot } from "../ticket/snapshot.ts";

const IMPLEMENT = "implement";
const CODE_REVIEW = "code-review";
const READ_REPLY = "read-reply";

// strictObject for the same reason ticketReviewVerdict is: the harness's
// native structured output carries additionalProperties:false, and a malformed
// verdict throws at the workflow-side parse rather than degrading into a guess.
export const codeReviewVerdict = z.strictObject({
  verdict: z.enum(["approved", "changes-requested"]),
  findings: z.array(z.string()),
});

// One flat object rather than a union: a harness's native structured output
// handles one shape reliably, and `action` is what the block branches on.
// `instructions` is read only on "continue", `about` and `questions` only on
// "ask".
export const replyReading = z.strictObject({
  action: z.enum(["continue", "ask"]),
  instructions: z.string(),
  about: z.string(),
  questions: z.array(haltQuestion),
});

export interface ImplementOptions {
  agent: AgentFn;
  haltForHuman: HaltForHumanFn;
  claim: TicketClaim;
  handoff: Handoff;
  harness: HarnessConfig;
  cwd: string;
  baseSha: string;
  // Each names a registered prompt; all default to the ones jigs ships.
  implementPrompt?: string;
  codeReviewPrompt?: string;
  readReplyPrompt?: string;
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

export async function implementUntilCodeReviewApproves(
  options: ImplementOptions,
): Promise<ImplementResult> {
  const { agent, haltForHuman } = options;
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
        prompt: {
          name: options.implementPrompt ?? IMPLEMENT,
          data: {
            TICKET: ticket,
            BRIEF: options.handoff.brief,
            REVIEW: review,
          },
        },
      });
      // The builder's session pointer, captured where the builder ran.
      session = build.session ?? session;

      const verdict = await agent({
        harness: options.harness,
        cwd: options.cwd,
        prompt: {
          name: options.codeReviewPrompt ?? CODE_REVIEW,
          data: { TICKET: ticket, BASE_SHA: options.baseSha },
        },
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

    let halt: Halt = {
      headline: `jigs paused work on **${identifier}**. The builder and the reviewer could not agree after ${MAX_REVIEW_CYCLES} rounds, and jigs needs you to decide how to proceed.`,
      notes: findings,
      questions: [{ question: "How should the builder proceed?" }],
      onReply: "continue",
    };

    // Uncapped, like the ticket review's: this is a conversation, and a person
    // who answers half of it is owed the other half rather than a failed run.
    for (;;) {
      const reply = await haltForHuman(options.claim, halt);
      const reading = await agent({
        harness: options.harness,
        cwd: options.cwd,
        prompt: {
          name: options.readReplyPrompt ?? READ_REPLY,
          data: {
            TICKET: ticket,
            FINDINGS: renderFindings(findings),
            REPLY: reply.body,
          },
        },
        output: replyReading,
      });
      console.log(
        `[implementUntilCodeReviewApproves] read the reply action=${reading.output.action}`,
      );
      if (reading.output.action === "continue") {
        review = reading.output.instructions;
        break;
      }
      halt = {
        headline: `jigs paused work on **${identifier}** again and needs one more answer before the builder continues.`,
        ...(reading.output.about === "" ? {} : { about: reading.output.about }),
        questions: reading.output.questions,
        onReply: "continue",
      };
    }
  }
}
