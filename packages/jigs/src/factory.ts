// What a factory declares its pipelines with, re-exported from the "." export.

import { z } from "zod";
import type { PipelineRequires } from "./checks/index.ts";

export const ticketInput = z.union([
  z.uuid(),
  z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
]);

/** What a pipeline body is handed: its own parsed inputs plus the `triggerId`
 *  the trigger injects on every run. */
export type PipelineInputs<S extends z.ZodType> = z.output<S> & {
  triggerId: string;
};

/** The same for a pipeline whose inputs carry a `ticket`: the trigger resolves
 *  the ref against Linear and injects the resolved pair, so the body reads it
 *  rather than resolving the ticket again. */
export type TicketPipelineInputs<S extends z.ZodType> = PipelineInputs<S> & {
  issueId: string;
  identifier: string;
};

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
