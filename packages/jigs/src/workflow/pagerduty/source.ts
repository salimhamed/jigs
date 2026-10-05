import { z } from "zod";
import type { SourceDescriptor } from "../factory.ts";

export const PAGERDUTY_INCIDENTS_SOURCE = "pagerduty.incidents";

// An empty list would match nothing, which no one means.
const ids = z.array(z.string().min(1)).min(1);

export const pagerDutyIncidentsParamsSchema = z.strictObject({
  services: ids.optional(),
  teams: ids.optional(),
  urgencies: z
    .array(z.enum(["high", "low"]))
    .min(1)
    .optional(),
});

/**
 * Which incidents a `pagerduty.incidents` source starts runs for. Each list
 * matches any of its values; leaving one out does not filter on it.
 *
 * - `services`: PagerDuty service IDs, such as `P48FPG2`.
 * - `teams`: PagerDuty team IDs.
 * - `urgencies`: `high`, `low` or both.
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
   * Watch for new incidents. Every new incident starts at most one run, ever,
   * with `{ incident: "<id>" }` as its inputs, even one acknowledged or
   * resolved before the service saw it; the workflow can check the status and
   * skip one that is already handled. The run starts as soon as the hub
   * passes on PagerDuty's `incident.triggered` event.
   *
   * @example
   * ```ts
   * import { pagerduty } from "@jigs-ai/jigs";
   *
   * const source = pagerduty.incidents({ services: ["P48FPG2"], urgencies: ["high"] });
   * ```
   */
  incidents(params: PagerDutyIncidentsParams = {}): SourceDescriptor {
    return { kind: PAGERDUTY_INCIDENTS_SOURCE, params: { ...params } };
  },
} as const;
