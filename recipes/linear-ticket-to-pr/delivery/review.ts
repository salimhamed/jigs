// What a code review returns, what the builder answers it with, and the ledger
// the two build up across rounds. `blocking` decides whether a round goes back
// to the builder: a review that blocks on every preference cannot converge
// inside a round budget. The rest is kept for a human on the pull request.

import { z } from "zod";

export const reviewFinding = z.strictObject({
  summary: z.string().min(1),
  /** A requirement left unmet, a defect a user could hit, or an untested risk that matters. */
  blocking: z.boolean(),
});

export const reviewVerdict = z.strictObject({
  verdict: z.enum(["approved", "changes-requested"]),
  findings: z.array(reviewFinding),
});

export const findingResponse = z.strictObject({
  /** The finding being answered, as the reviewer stated it. */
  finding: z.string().min(1),
  changed: z.boolean(),
  /** What was changed, or why it was not. The reviewer judges the reason. */
  detail: z.string(),
});

export const implementationReport = z.strictObject({
  responses: z.array(findingResponse),
});

export const pullRequestDescription = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
});

export type ReviewFinding = z.output<typeof reviewFinding>;
export type ReviewVerdict = z.output<typeof reviewVerdict>;
export type FindingResponse = z.output<typeof findingResponse>;

export interface ReviewRound {
  round: number;
  /** The builder's answers to the previous round's findings; empty on the first round. */
  responses: FindingResponse[];
  verdict: ReviewVerdict["verdict"];
  findings: ReviewFinding[];
}

export const renderFinding = (finding: ReviewFinding) =>
  finding.blocking ? finding.summary : `${finding.summary} (non-blocking)`;

export const renderFindings = (findings: ReviewFinding[]) =>
  findings.map((finding) => `- ${renderFinding(finding)}`).join("\n");

export const renderResponses = (responses: FindingResponse[]) =>
  responses
    .map((r) => `- ${r.finding}\n  ${r.changed ? "changed" : "not changed"}: ${r.detail}`)
    .join("\n");

export const renderLedger = (rounds: ReviewRound[]) =>
  rounds
    .map((round) =>
      [
        `Round ${round.round}: ${round.verdict}`,
        round.responses.length === 0
          ? ""
          : `Builder responses:\n${renderResponses(round.responses)}`,
        round.findings.length === 0 ? "No findings." : renderFindings(round.findings),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

/** The observations an approving round left behind, for the pull request body. */
export function reviewerNotes(rounds: ReviewRound[]): string[] {
  const last = rounds.at(-1);
  if (last === undefined || last.verdict !== "approved") return [];
  return last.findings.filter((finding) => !finding.blocking).map((finding) => finding.summary);
}
