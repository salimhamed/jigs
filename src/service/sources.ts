// The service-side half of an event trigger's source: how to read a kind's
// occurrences from its provider. Config holds only the plain descriptor; this
// registry, keyed by the descriptor's `kind`, is what the engine runs.

import type { z } from "zod";
import type { FactoryConfig } from "../config/factory-config.ts";
import { PAGERDUTY_INCIDENTS_SOURCE } from "../workflow/pagerduty/source.ts";
import { pagerDutyIncidents } from "./pagerduty-incidents.ts";
import { SLACK_SOURCES } from "./slack-sources.ts";

/** A provider with its own `service.pollIntervalSeconds` entry. */
export type SourceProvider = keyof FactoryConfig["service"]["pollIntervalSeconds"];

/** One occurrence as a source reports it: the reference the run reads, and when it happened. */
export interface SourceOccurrence {
  inputs: Record<string, unknown>;
  at: Date;
}

export interface Source<P = unknown> {
  provider: SourceProvider;
  /** Validates the descriptor's `params`. */
  params: z.ZodType<P>;
  /** A representative of the inputs this source hands every run, which doctor checks the
   *  trigger's workflow accepts. */
  sampleInputs: Record<string, unknown>;
  /** The occurrence key, read off the inputs so a polled and a pushed occurrence cannot disagree. */
  occurrence(inputs: Record<string, unknown>): string;
  /** Occurrences since the given time. Overlap with an earlier poll is harmless. */
  poll(params: P, since: Date): Promise<SourceOccurrence[]>;
  /** The same occurrence from a pushed provider event, or null when the event is not one. */
  fromPush(params: P, event: unknown): Promise<SourceOccurrence | null>;
}

// biome-ignore lint/suspicious/noExplicitAny: each kind has its own params
export type SourceRegistry = Readonly<Record<string, Source<any>>>;

export const SOURCES: SourceRegistry = {
  ...SLACK_SOURCES,
  [PAGERDUTY_INCIDENTS_SOURCE]: pagerDutyIncidents(),
};
