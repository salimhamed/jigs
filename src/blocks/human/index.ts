/**
 * Describe structured questions and JSON values exchanged with a human.
 *
 * @packageDocumentation
 */

import { z } from "zod";

/** Interpolated into a prompt or a comment; never rendered as one. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Declared as zod rather than as a bare type so a model step can emit a
// question directly, as ticket review does.
export const haltOptionSchema = z.strictObject({
  label: z.string().min(1),
  recommended: z.boolean().optional(),
});

export const haltQuestionSchema = z.strictObject({
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(haltOptionSchema).optional(),
});

export type HaltOption = z.infer<typeof haltOptionSchema>;
export type HaltQuestion = z.infer<typeof haltQuestionSchema>;
