import { z } from "zod";
import type { SourceDescriptor } from "../factory.ts";
import { installationNameSchema } from "../factory-schema.ts";

export const LINEAR_AGENT_SESSIONS_SOURCE = "linear.agentSessions";

// An empty list would match nothing, which no one means.
const names = z.array(z.string().min(1)).min(1);

export const linearAgentSessionsParamsSchema = z.strictObject({
  installationName: installationNameSchema,
  teams: names.optional(),
  projects: names.optional(),
  labels: names.optional(),
});

/**
 * Which Linear agent sessions a `linear.agentSessions` source starts runs for,
 * matched on the session's issue. Each list matches any of its values; leaving
 * one out does not filter on it.
 *
 * - `installationName`: the Linear installation, as named on the hub, whose
 *   sessions it watches.
 * - `teams`: team keys, such as `ENG`, or team ids.
 * - `projects`: project ids, or the id at the end of a project's URL.
 * - `labels`: label names, as Linear shows them.
 *
 * @group Factory and workflows
 */
export type LinearAgentSessionsParams = z.input<typeof linearAgentSessionsParamsSchema>;

/**
 * The inputs a `linear.agentSessions` source hands each run it starts.
 *
 * @group Factory and workflows
 */
export interface LinearAgentSessionInputs {
  /** The Linear agent session's id. */
  session: string;
  /** The Linear installation, as named on the hub, the session is in. */
  installationName: string;
  issue: { id: string; identifier: string; title: string; url: string };
  /** The body of the comment the session started from, or null when an assignment started it. */
  comment: string | null;
  /** The person who started the session, or null when an automation did. */
  creator: { id: string; name: string; email: string } | null;
}

/**
 * Event-trigger sources on Linear.
 *
 * @group Factory and workflows
 */
export const linear = {
  /**
   * Start a run whenever someone mentions the factory's Linear app on an
   * issue, or assigns an issue to it. Each Linear agent session starts at most
   * one run, ever, with {@link LinearAgentSessionInputs} as its inputs. The
   * hub posts the session's first reply, so Linear shows the app at work
   * while the run starts.
   *
   * @remarks
   * Every factory assigned the app hears every mention of it, and each of
   * their triggers on this source starts its own run. To have one run answer,
   * give each purpose its own Linear app, or split the issues between triggers
   * with `teams`, `projects` and `labels`. The hub's first reply appears even
   * when the filters skip a session and no run starts, so make the filters
   * match what the app is for. Sessions not on an issue start no run.
   *
   * @example
   * ```ts
   * import { linear } from "@jigs-ai/jigs";
   *
   * const source = linear.agentSessions({
   *   installationName: "acme",
   *   teams: ["ENG"],
   *   labels: ["agent"],
   * });
   * ```
   */
  agentSessions(params: LinearAgentSessionsParams): SourceDescriptor {
    return { kind: LINEAR_AGENT_SESSIONS_SOURCE, params: { ...params } };
  },
} as const;
