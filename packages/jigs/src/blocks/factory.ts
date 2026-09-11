// What a factory declares its pipelines with, re-exported from the "." export.

import { z } from "zod";
import type { PipelineRequires } from "../checks/index.ts";

export const ticketInput = z.union([
  z.uuid(),
  z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
]);

/** What the trigger injects beside a pipeline's own parsed inputs. Exported
 *  for the trigger to `satisfies` its injected object against: the pipeline
 *  types below are built from these two, so a field on one side and not the
 *  other fails to compile. */
export type Injected = { triggerId: string };
export type TicketInjected = Injected & {
  issueId: string;
  identifier: string;
};

/** What a pipeline body is handed: its own parsed inputs plus the `triggerId`
 *  the trigger injects on every run. */
export type PipelineInputs<S extends z.ZodType> = z.output<S> & Injected;

/** The same for a pipeline whose inputs carry a `ticket`: the trigger resolves
 *  the ref against Linear and injects the resolved pair, so the body reads it
 *  rather than resolving the ticket again. The constraint is the honest half —
 *  a schema with no required `ticket` gets nothing resolved. */
export type TicketPipelineInputs<S extends z.ZodType<{ ticket: string }>> =
  z.output<S> & TicketInjected;

export interface PipelineEntry<S extends z.ZodType = z.ZodType> {
  pipeline: (inputs: PipelineInputs<S>) => Promise<unknown>;
  inputs: S;
  // The manifest half of preflight's computed check list.
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
