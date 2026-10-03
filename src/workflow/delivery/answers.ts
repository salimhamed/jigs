// What each delivery agent answers, and the one line the engine appends to the
// caller's prompt so the agent answers in that shape. Everything else an agent
// is told is the caller's.

import { z } from "zod";

const reviewFinding = z.strictObject({
  summary: z.string().min(1),
  blocking: z.boolean(),
});

export const reviewVerdict = z.strictObject({
  verdict: z.enum(["approved", "changes-requested"]),
  findings: z.array(reviewFinding),
});

const findingResponse = z.strictObject({
  finding: z.string().min(1),
  changed: z.boolean(),
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

export const maintenanceReport = z.strictObject({
  status: z.enum(["finished", "pending", "needs-human"]),
  summary: z.string().min(1),
});

/**
 * One finding from a review of the change.
 *
 * @group Pull request delivery
 */
export type ReviewFinding = z.output<typeof reviewFinding>;

/**
 * The builder's answer to one finding: what it changed, or why it changed nothing.
 *
 * @group Pull request delivery
 */
export type FindingResponse = z.output<typeof findingResponse>;

/**
 * One build and the review of what it committed.
 *
 * @group Pull request delivery
 */
export interface ReviewRound {
  round: number;
  /** The builder's answers to the previous round's findings; empty on the first round. */
  responses: FindingResponse[];
  /** Decided by whether any finding is blocking, whatever verdict the reviewer stated. */
  verdict: "approved" | "changes-requested";
  findings: ReviewFinding[];
}

export const formats = {
  build:
    "Answer every finding you were given, one response each, quoting the finding as it was stated. Set changed to true with what you changed, or to false with the reason you did not: a finding you decline stays open until the reviewer accepts your reason, so give one it can judge. Return no responses when you were given no findings.",
  review:
    "Mark each finding blocking or not: only a blocking finding sends the change back to the builder. Return changes-requested only when a blocking finding remains; otherwise return approved and keep the non-blocking findings.",
  describe:
    'Return the title as one line of plain text, 72 characters or fewer, with no markdown and no "Title:" label, and the body as markdown that does not repeat the title or label its parts "Title:" or "Description:".',
  maintain:
    "Return finished only when no work remains for you on the current code and discussion, pending when you are waiting for checks or another external change, or needs-human only when a person must act before you can continue. Explain the result in summary; for needs-human, say what the person needs to do.",
};

/** The caller's prompt with the engine's answer format after it. */
export const withFormat = (prompt: string, format: string) => `${prompt}\n\n${format}`;
