// The service-side half of an event trigger's source: how to read a kind's
// occurrences from its provider. Config holds only the plain descriptor; this
// registry, keyed by the descriptor's `kind`, is what the engine runs.

import type { z } from "zod";
import { PAGERDUTY_INCIDENTS_SOURCE } from "../../workflow/pagerduty/source.ts";
import type { Provider } from "../../workflow/providers.ts";
import { pagerDutyIncidents } from "../pagerduty-incidents.ts";
import { SLACK_SOURCES } from "../slack-sources.ts";

/** One occurrence as a source reports it: the reference the run reads, and when it happened. */
export interface SourceOccurrence {
  inputs: Record<string, unknown>;
  at: Date;
}

/** What a poll found, and how far the source has now read. */
export interface SourcePoll<C> {
  occurrences: SourceOccurrence[];
  cursor: C;
}

export interface Source<P = unknown, C = unknown> {
  provider: Provider;
  /** Validates the descriptor's `params`. */
  params: z.ZodType<P>;
  /** Validates the cursor an earlier poll returned, as the store hands it back. */
  cursor: z.ZodType<C>;
  /** A representative of the inputs this source hands every run, which doctor checks the
   *  trigger's workflow accepts. */
  sampleInputs: Record<string, unknown>;
  /** The occurrence key, read off the inputs so a polled and a pushed occurrence cannot disagree. */
  occurrence(inputs: Record<string, unknown>): string;
  /**
   * Occurrences since the cursor an earlier poll returned, or since `floor` when there is none.
   * Never reads from before `floor`. Overlap with an earlier poll is harmless.
   */
  poll(params: P, cursor: C | undefined, floor: Date): Promise<SourcePoll<C>>;
  /** The same occurrence from a pushed provider event, or null when the event is not one. */
  fromPush(params: P, event: unknown): Promise<SourceOccurrence | null>;
  /** What a run this source started was started for, in an operator's words, read off its inputs. */
  describe(inputs: Record<string, unknown>): string;
}

// biome-ignore lint/suspicious/noExplicitAny: each kind has its own params and cursor
export type SourceRegistry = Readonly<Record<string, Source<any, any>>>;

export const SOURCES: SourceRegistry = {
  ...SLACK_SOURCES,
  [PAGERDUTY_INCIDENTS_SOURCE]: pagerDutyIncidents(),
};
