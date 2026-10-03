// What each delivery agent answers, and the one line the engine appends to the
// caller's prompt so the agent answers in that shape. Everything else an agent
// is told is the caller's.

import { z } from "zod";

const reviewFinding = z.strictObject({
  summary: z.string().min(1),
  blocking: z.boolean(),
});

export const reviewVerdict = z.strictObject({
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
    .regex(/^[^\r\n]*$/, "The title must be a single line.")
    .refine((title) => !markdownStart.test(title), "The title must be plain text, not markdown.")
    .refine((title) => !titleLabel.test(title), 'The title must not start with a "Title:" label.')
    .describe(
      'The pull request title itself: one short line of plain text, with no markdown and no "Title:" label.',
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
  needsHuman: z.boolean(),
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
  /** `changes-requested` when any finding is blocking. */
  verdict: "approved" | "changes-requested";
  findings: ReviewFinding[];
}

export const formats = {
  build:
    "Return one response per finding you were given, with the finding quoted as it was stated. Set changed to true and say in detail what you changed, or set it to false and give the reason in detail. Return no responses when you were given no findings.",
  review:
    "Return each finding as a one-sentence summary, with blocking set to whether it must be fixed before the change can go ahead. Return no findings when you have none.",
  describe:
    'Return the title as one short line of plain text, with no markdown and no "Title:" label, and the body as markdown that does not repeat the title or label its parts "Title:" or "Description:".',
  maintain:
    "Set needsHuman to true when a person must act before you can continue, and false otherwise. Say in summary what you did, or what the person needs to do.",
};

/** The caller's prompt with the engine's answer format after it. */
export const withFormat = (prompt: string, format: string) => `${prompt}\n\n${format}`;
