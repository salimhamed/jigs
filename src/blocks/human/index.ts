/**
 * Use these schemas and types for provider-neutral questions and JSON values exchanged with a human.
 *
 * @packageDocumentation
 */

import { z } from "zod";

/** A value that can be serialized as JSON and embedded in a prompt or comment. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Validates an answer choice with a nonempty label and an optional recommendation marker. */
export const haltOptionSchema = z.strictObject({
  /** The text shown for this choice. */
  label: z.string().min(1),
  /** Whether to identify this choice as the recommended answer. */
  recommended: z.boolean().optional(),
});

/** Validates a question with nonempty text, optional context and optional suggested answers. */
export const haltQuestionSchema = z.strictObject({
  /** The question to answer. */
  question: z.string().min(1),
  /** Supporting details shown below the question. */
  context: z.string().optional(),
  /** Suggested answers. Omit this field when a free-form answer is appropriate. */
  options: z.array(haltOptionSchema).optional(),
});

/** One answer choice for a question shown to a human. */
export type HaltOption = z.infer<typeof haltOptionSchema>;

/** A question shown to a human while a run waits for their reply. */
export type HaltQuestion = z.infer<typeof haltQuestionSchema>;
