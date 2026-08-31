// The "." export. It must never re-export a module carrying a "use step"/"use
// workflow" directive: routing the workflow surface through one specifier
// changes the step ids the SDK derives from the export subpath.
import type { PipelineRequires } from "jigs/checks";
import { z } from "zod";

export const ticketInput = z.union([
  z.uuid(),
  z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
]);

export interface PipelineEntry<S extends z.ZodType = z.ZodType> {
  pipeline: (inputs: z.output<S> & { triggerId: string }) => Promise<unknown>;
  inputs: S;
  hookToken?: (triggerId: string) => string;
  // The manifest half of preflight's computed check list (ADR 0010).
  requires?: PipelineRequires;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per entry
export type AnyPipelineEntry = PipelineEntry<any>;

/** What a factory repo hands the service: its pipelines, keyed by name. */
export interface Factory {
  pipelines: Record<string, AnyPipelineEntry>;
}
