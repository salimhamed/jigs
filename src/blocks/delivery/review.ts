// What a code review returns, what the builder answers it with, and the ledger
// the two build up across rounds.
//
// `blocking` is the load-bearing field. A review that blocks on every
// preference cannot converge inside a round budget, so the reviewer states
// which findings are defects and which are observations, and only the first
// kind sends the round back to the builder. The rest are kept and written into
// the pull request description, where a human still reads them.
//
// The ledger is the durable record of all that, and the context a reviewer is
// rebuilt from when its harness session is gone.

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

/** What an implementation attempt returns: its answer to each finding it was given. */
export const implementationReport = z.strictObject({
  responses: z.array(findingResponse),
});

export type ReviewFinding = z.output<typeof reviewFinding>;
export type ReviewVerdict = z.output<typeof reviewVerdict>;
export type FindingResponse = z.output<typeof findingResponse>;
export type ImplementationReport = z.output<typeof implementationReport>;

/** One implementation-review round, as the ledger records it. */
export interface ReviewRound {
  /** The round number, counting from 1. */
  round: number;
  /** The builder's answer to the previous round's findings; empty on the first round. */
  responses: FindingResponse[];
  verdict: ReviewVerdict["verdict"];
  findings: ReviewFinding[];
}

/** One finding as a plain line, keeping the distinction the reviewer drew. */
export function renderFinding(finding: ReviewFinding): string {
  return finding.blocking ? finding.summary : `${finding.summary} (non-blocking)`;
}

export function renderFindings(findings: ReviewFinding[]): string {
  return findings.map((finding) => `- ${renderFinding(finding)}`).join("\n");
}

export function renderResponses(responses: FindingResponse[]): string {
  return responses
    .map(
      (response) =>
        `- ${response.finding}\n  ${response.changed ? "changed" : "not changed"}: ${response.detail}`,
    )
    .join("\n");
}

/** Every earlier round, for a reviewer that holds no session of its own. */
export function renderLedger(rounds: ReviewRound[]): string {
  return rounds
    .map((round) =>
      [
        `Round ${round.round} — ${round.verdict}`,
        round.responses.length === 0
          ? ""
          : `The builder answered your previous findings:\n${renderResponses(round.responses)}`,
        round.findings.length === 0 ? "No findings." : renderFindings(round.findings),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

/** The observations an approving round left behind, for the pull request body. */
export function reviewerNotes(rounds: ReviewRound[]): string[] {
  const last = rounds.at(-1);
  if (last === undefined || last.verdict !== "approved") return [];
  return last.findings.filter((finding) => !finding.blocking).map((finding) => finding.summary);
}
