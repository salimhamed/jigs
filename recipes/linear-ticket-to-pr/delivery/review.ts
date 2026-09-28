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

// The schema the model sees carries none of these checks, only the
// descriptions, so each description states its rules; the parse enforces them.
// Case matters: a lowercase `title: ...` is a conventional-commit title, not a label.
const titleLabel = /^\s*(\*\*|__)?\s*Title\s*:/;
const markdownStart = /^\s*(#{1,6}\s|\*\*|__)/;
const bodyLabel = /^\s*(\*\*|__)?\s*(title|description)\s*:/im;

export const pullRequestDescription = z.strictObject({
  title: z
    .string()
    .min(1)
    .max(100, "The title must be 100 characters or fewer; aim for 72.")
    .regex(/^[^\r\n]*$/, "The title must be a single line.")
    .refine((title) => !markdownStart.test(title), "The title must be plain text, not markdown.")
    .refine((title) => !titleLabel.test(title), 'The title must not start with a "Title:" label.')
    .describe(
      'The pull request title itself: one line of plain text, 72 characters or fewer, with no markdown and no "Title:" label.',
    ),
  body: z
    .string()
    .min(1)
    .refine(
      (body) => !bodyLabel.test(body),
      'The body must not contain a "Title:" or "Description:" label line.',
    )
    .describe(
      'The pull request body in markdown. It does not repeat the title or label itself "Title:" or "Description:".',
    ),
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
