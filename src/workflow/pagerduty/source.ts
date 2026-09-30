import { z } from "zod";
import type { SourceDescriptor } from "../factory.ts";

export const PAGERDUTY_INCIDENTS_SOURCE = "pagerduty.incidents";

// An empty list would send no filter at all and match every incident on the
// account, so a list, when given, names at least one value.
const ids = z.array(z.string().min(1)).min(1);

export const pagerDutyIncidentsParamsSchema = z.strictObject({
  service_ids: ids.optional(),
  team_ids: ids.optional(),
  urgencies: z
    .array(z.enum(["high", "low"]))
    .min(1)
    .optional(),
});

/**
 * Which incidents a `pagerduty.incidents` source watches, in PagerDuty's own
 * list-incidents parameters. Each list matches any of its values; leaving one
 * out does not filter on it.
 *
 * @group Factory and workflows
 */
export type PagerDutyIncidentsParams = z.input<typeof pagerDutyIncidentsParamsSchema>;

/**
 * Event-trigger sources on PagerDuty.
 *
 * @group Factory and workflows
 */
export const pagerduty = {
  /**
   * Watch for newly triggered incidents. Each incident starts at most one run,
   * ever, with `{ incident: "<id>" }` as its inputs; an incident that is still
   * triggered after its run ends does not start another. The service polls on
   * `service.pollIntervalSeconds.pagerduty`.
   *
   * @example
   * ```ts
   * import { pagerduty } from "@jigs-ai/jigs";
   *
   * const source = pagerduty.incidents({ service_ids: ["P48FPG2"], urgencies: ["high"] });
   * ```
   */
  incidents(params: PagerDutyIncidentsParams = {}): SourceDescriptor {
    return { kind: PAGERDUTY_INCIDENTS_SOURCE, params: { ...params } };
  },
} as const;
