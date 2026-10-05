// The service-side half of an event trigger's source: how to read a kind's
// occurrences from its provider's pushed events. Config holds only the plain descriptor; this
// registry, keyed by the descriptor's `kind`, is what the engine runs.

import type { z } from "zod";
import { LINEAR_AGENT_SESSIONS_SOURCE } from "../../workflow/linear/source.ts";
import { PAGERDUTY_INCIDENTS_SOURCE } from "../../workflow/pagerduty/source.ts";
import type { Provider } from "../../workflow/providers.ts";
import { linearAgentSessions } from "../linear-agent-sessions.ts";
import { pagerDutyIncidents } from "../pagerduty-incidents.ts";
import { SLACK_SOURCES } from "../slack-sources.ts";

/** One occurrence as a source reports it: the reference the run reads, and when it happened. */
export interface SourceOccurrence {
  inputs: Record<string, unknown>;
  at: Date;
}

export interface Source<P = unknown> {
  provider: Provider;
  /** Validates the descriptor's `params`. */
  params: z.ZodType<P>;
  /** A representative of the inputs this source hands every run, which doctor checks the
   *  trigger's workflow accepts. */
  sampleInputs: Record<string, unknown>;
  /** The occurrence key, read off the inputs. */
  occurrence(inputs: Record<string, unknown>): string;
  /** The occurrence a pushed provider event is, or null when the event is not one. */
  fromPush(params: P, event: unknown): Promise<SourceOccurrence | null>;
  /** What a run this source started was started for, in an operator's words, read off its inputs. */
  describe(inputs: Record<string, unknown>): string;
}

// biome-ignore lint/suspicious/noExplicitAny: each kind has its own params
export type SourceRegistry = Readonly<Record<string, Source<any>>>;

export const SOURCES: SourceRegistry = {
  ...SLACK_SOURCES,
  [PAGERDUTY_INCIDENTS_SOURCE]: pagerDutyIncidents(),
  [LINEAR_AGENT_SESSIONS_SOURCE]: linearAgentSessions(),
};
