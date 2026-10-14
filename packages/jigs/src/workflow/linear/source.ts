import { z } from "zod";
import type { SourceDescriptor } from "../factory.ts";
import { installationNameSchema } from "../factory-schema.ts";

export const LINEAR_DELEGATIONS_SOURCE = "linear.delegations";
export const LINEAR_MENTIONS_SOURCE = "linear.mentions";

// An empty list would match nothing, which no one means.
const names = z.array(z.string().min(1)).min(1);

export const linearAgentSessionsParamsSchema = z.strictObject({
  installationName: installationNameSchema,
  teams: names.optional(),
  projects: names.optional(),
  labels: names.optional(),
  creators: names.optional(),
});

/**
 * Which Linear agent sessions a `linear.delegations` or `linear.mentions`
 * source starts runs for. Each list matches any of its values; leaving one out
 * does not filter on it.
 *
 * - `installationName`: the Linear installation, as named on the hub, whose
 *   sessions it watches.
 * - `teams`: team keys, such as `ENG`, or team ids.
 * - `projects`: project ids, or the id at the end of a project's URL.
 * - `labels`: label names, as Linear shows them.
 * - `creators`: emails of the people who delegated the issue or mentioned the
 *   app, in any case.
 *
 * @group Factory and workflows
 */
export type LinearAgentSessionsParams = z.input<typeof linearAgentSessionsParamsSchema>;

/**
 * The inputs a `linear.delegations` source hands each run it starts.
 *
 * @group Factory and workflows
 */
export interface LinearDelegationInputs {
  /** The Linear agent session's id. */
  session: string;
  /** The Linear installation, as named on the hub, the session is in. */
  installationName: string;
  issue: { id: string; identifier: string; title: string; url: string };
  /**
   * Linear's formatted context for the session: the issue, its description and the comments
   * around it, or null if Linear sent none.
   */
  promptContext: string | null;
  /** The person who delegated the issue, or mentioned the app. */
  creator: { id: string; name: string; email: string };
}

/**
 * The inputs a `linear.mentions` source hands each run it starts.
 *
 * @group Factory and workflows
 */
export interface LinearMentionInputs extends LinearDelegationInputs {
  /** The body of the comment that mentioned the app. */
  comment: string;
}

/**
 * Event-trigger sources on Linear.
 *
 * @remarks
 * Delegating an issue to the factory's Linear app, or mentioning the app in a
 * comment, opens a Linear agent session. Each session starts at most one run
 * per trigger, ever. The hub posts the session's first reply, so Linear shows
 * the app at work while the run starts. That reply appears even when no
 * trigger matches, so make the filters match what the app is for. Every
 * factory assigned the app hears every session, and each matching trigger
 * starts its own run. Sessions not on an issue, and sessions the app opened
 * itself, start no run.
 *
 * @group Factory and workflows
 */
export const linear = {
  /**
   * Start a run whenever someone delegates an issue to the factory's Linear
   * app, with {@link LinearDelegationInputs} as its inputs.
   *
   * @example
   * ```ts
   * import { linear } from "@jigs-ai/jigs";
   *
   * const source = linear.delegations({ installationName: "acme", teams: ["ENG"] });
   * ```
   */
  delegations(params: LinearAgentSessionsParams): SourceDescriptor {
    return { kind: LINEAR_DELEGATIONS_SOURCE, params: { ...params } };
  },
  /**
   * Start a run whenever someone mentions the factory's Linear app in a
   * comment on an issue, with {@link LinearMentionInputs} as its inputs.
   *
   * @example
   * ```ts
   * import { linear } from "@jigs-ai/jigs";
   *
   * const source = linear.mentions({ installationName: "acme", labels: ["agent"] });
   * ```
   */
  mentions(params: LinearAgentSessionsParams): SourceDescriptor {
    return { kind: LINEAR_MENTIONS_SOURCE, params: { ...params } };
  },
} as const;
