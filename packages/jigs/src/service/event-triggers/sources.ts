// The service-side half of an event trigger's source: how to read a kind's
// occurrences from its provider's pushed events. Config holds only the plain
// descriptor; this registry, keyed by the descriptor's `kind`, is what the
// engine runs.

import type { z } from "zod";
import { LINEAR_AGENT_SESSIONS_SOURCE } from "../../workflow/linear/source.ts";
import { PAGERDUTY_INCIDENTS_SOURCE } from "../../workflow/pagerduty/source.ts";
import type { Provider } from "../../workflow/providers.ts";
import { LINEAR_AGENT_SESSIONS } from "../linear-agent-sessions.ts";
import { PAGERDUTY_INCIDENTS } from "../pagerduty-incidents.ts";
import { SLACK_SOURCES } from "../slack-sources.ts";

/** One occurrence as a source reports it: its key, the reference the run reads, and when it happened. */
export interface SourceOccurrence {
  /** Names the occurrence however often its event arrives, so it starts at most one run. */
  key: string;
  inputs: Record<string, unknown>;
  at: Date;
}

/** A provider event the hub passed on, with the named installation it came through. */
export interface PushedEvent {
  installationName: string;
  payload: unknown;
}

export interface Source<P = unknown> {
  provider: Provider;
  /** Validates the descriptor's `params`. */
  params: z.ZodType<P>;
  /** A representative of the inputs this source hands every run, which doctor checks the
   *  trigger's workflow accepts. */
  sampleInputs: Record<string, unknown>;
  /**
   * The occurrence a pushed provider event is, or null when the event is not
   * one, such as an event from another installation or of another type. It
   * sees every event its provider sends, so it rejects those before any
   * network call. Throws when it could not tell; the event is routed again
   * unless the error is one a retry would only get again.
   */
  fromPush(params: P, event: PushedEvent): Promise<SourceOccurrence | null>;
  /** What a run this source started was started for, in an operator's words, read off its inputs. */
  describe(inputs: Record<string, unknown>): string;
}

// biome-ignore lint/suspicious/noExplicitAny: each kind has its own params
export type SourceRegistry = Readonly<Record<string, Source<any>>>;

export const SOURCES: SourceRegistry = {
  ...SLACK_SOURCES,
  [PAGERDUTY_INCIDENTS_SOURCE]: PAGERDUTY_INCIDENTS,
  [LINEAR_AGENT_SESSIONS_SOURCE]: LINEAR_AGENT_SESSIONS,
};
