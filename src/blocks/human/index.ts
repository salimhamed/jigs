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
export const haltOption = z.strictObject({
  label: z.string().min(1),
  recommended: z.boolean().optional(),
});

export const haltQuestion = z.strictObject({
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(haltOption).optional(),
});

export type HaltOption = z.infer<typeof haltOption>;
export type HaltQuestion = z.infer<typeof haltQuestion>;
