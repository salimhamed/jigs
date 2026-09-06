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
  // The manifest half of preflight's computed check list (ADR 0010).
  requires?: PipelineRequires;
}

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas per entry
export type AnyPipelineEntry = PipelineEntry<any>;

/** One recurring trigger: a pipeline, when to fire it, and the inputs to
 *  fire it with. */
export interface Schedule {
  pipeline: string;
  /** Five fields, evaluated in the service host's local time zone. */
  cron: string;
  inputs: Record<string, unknown>;
}

/**
 * What a factory repo hands the service: its pipelines, keyed by name, and
 * the schedules that fire them. A schedule is keyed by its own name rather
 * than nested under a pipeline — the name is what runs, logs and `jigs
 * doctor` refer to, and one pipeline can carry several.
 */
export interface Factory {
  pipelines: Record<string, AnyPipelineEntry>;
  schedules?: Record<string, Schedule>;
}
