// The implement ⇄ review half of the review loop (ADR 0003): the circuit
// breaker is a plain loop bound, and the halt it ends on is a pause a human
// ends — never a terminal state, so nothing the builder produced is discarded.

import { codeReviewPrompt, implementPrompt, interpolate } from "jigs/prompts";
import type { AgentSession, HarnessConfig } from "jigs/steps";
import { z } from "zod";
import { agent } from "../steps";
import type { TicketClaim } from "../suspension/claim";
import { needsHuman } from "../suspension/needs-human";
import type { Handoff } from "../ticket/review";
import { renderSnapshot } from "../ticket/snapshot";

// strictObject for the same reason ticketReviewVerdict is: the harness's
// native structured output carries additionalProperties:false, and a malformed
// verdict throws at the workflow-side parse rather than degrading into a guess.
export const codeReviewVerdict = z.strictObject({
  verdict: z.enum(["approved", "changes-requested"]),
  findings: z.array(z.string()),
});

export interface ImplementAndReviewOptions {
  claim: TicketClaim;
  handoff: Handoff;
  harness: HarnessConfig;
  cwd: string;
  baseSha: string;
  maxCycles?: number;
  // Interpolated with the same inert {{KEY}} pass as the defaults.
  prompt?: string;
  reviewPrompt?: string;
}

export type ImplementAndReviewResult = {
  session?: AgentSession;
  cycles: number;
};

// Workflow-side only: these never cross the step serialization boundary.
export type ImplementDeps = {
  agent: typeof agent;
  needsHuman: typeof needsHuman;
};

const realDeps: ImplementDeps = { agent, needsHuman };

const FIRST_PASS = "_(first pass)_";

function renderFindings(findings: string[]): string {
  return findings.length === 0
    ? "_(the reviewer requested changes without naming any)_"
    : findings.map((finding) => `- ${finding}`).join("\n");
}

export async function implementAndReview(
  options: ImplementAndReviewOptions,
  deps: ImplementDeps = realDeps,
): Promise<ImplementAndReviewResult> {
  const maxCycles = options.maxCycles ?? 3;
  const ticket = renderSnapshot(options.handoff.snapshot);
  let session: AgentSession | undefined;
  let review = FIRST_PASS;
  let findings: string[] = [];
  let cycles = 0;

  // Outer loop: the needs-human halt is a pause, so a human's reply becomes
  // the next round's findings and the run is never stranded.
  for (;;) {
    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      cycles += 1;
      const build = await deps.agent({
        harness: options.harness,
        cwd: options.cwd,
        // The builder has to run git to commit, and acceptEdits still prompts
        // on Bash, which hangs headless.
        permissionMode: "bypassPermissions",
        prompt: interpolate(options.prompt ?? implementPrompt, {
          TICKET: ticket,
          BRIEF: options.handoff.brief,
          REVIEW: review,
        }),
      });
      // The builder's session pointer, captured where the builder ran.
      session = build.session ?? session;

      const verdict = await deps.agent({
        harness: options.harness,
        cwd: options.cwd,
        // The reviewer's whole prompt is built around running git diff, and
        // Bash is not auto-approved below this mode.
        permissionMode: "bypassPermissions",
        prompt: interpolate(options.reviewPrompt ?? codeReviewPrompt, {
          TICKET: ticket,
          BASE_SHA: options.baseSha,
        }),
        output: codeReviewVerdict,
      });
      findings = verdict.output.findings;
      console.log(
        `[reviewLoop] cycle ${cycle}/${maxCycles} verdict=${verdict.output.verdict} findings=${findings.length}`,
      );
      if (verdict.output.verdict === "approved") {
        return {
          ...(session !== undefined ? { session } : {}),
          cycles,
        };
      }
      review = renderFindings(findings);
    }

    const reply = await deps.needsHuman(
      options.claim,
      `review loop hit its ${maxCycles}-cycle bound`,
      { findings },
    );
    review = reply.body;
  }
}
