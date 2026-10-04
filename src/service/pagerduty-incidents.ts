// The `pagerduty.incidents` source: every new incident is one occurrence,
// keyed by its incident id, whatever its status by the time it is polled.
// A webhook's `incident.triggered` event is the same occurrence, sooner.

import { z } from "zod";
import { type PagerDutyClient, pagerDutyClientFor } from "../providers/pagerduty.ts";
import {
  type PagerDutyIncidentsParams,
  pagerDutyIncidentsParamsSchema,
} from "../workflow/pagerduty/source.ts";
import type { Source } from "./sources.ts";

// `since` filters on created_at, and an incident can surface in the list a
// little after it was created, or by a clock a little ahead of this one. Each
// poll reaches this far behind the last; the store drops what it already saw.
export const POLL_OVERLAP_MS = 5 * 60_000;
// PagerDuty refuses a range over six months, and with no `until` it ends the
// range a month after `since`, which would hide everything recent after a long
// downtime. So the range is always stated, and never longer than this.
const MAX_RANGE_MS = 179 * 24 * 60 * 60_000;
// Clock skew the other way: an incident stamped a moment ahead of this clock.
const UNTIL_MARGIN_MS = 60 * 60_000;

// Only what the occurrence and the source's filters read; PagerDuty sends more.
const triggeredSchema = z.object({
  event: z.object({
    event_type: z.literal("incident.triggered"),
    data: z.object({
      id: z.string().min(1),
      created_at: z.iso.datetime({ offset: true }),
      service: z.object({ id: z.string() }),
      teams: z.array(z.object({ id: z.string() })).default([]),
      urgency: z.string(),
    }),
  }),
});

const eventTypeSchema = z.object({ event: z.object({ event_type: z.string() }) });

/** A PagerDuty webhook payload's event type, if it names one. */
export const pagerDutyEventType = (event: unknown): string | undefined =>
  eventTypeSchema.safeParse(event).data?.event.event_type;

export interface PagerDutyIncidentsDeps {
  client?: () => PagerDutyClient;
  now?: () => Date;
}

export function pagerDutyIncidents(
  deps: PagerDutyIncidentsDeps = {},
): Source<PagerDutyIncidentsParams> {
  const client = deps.client ?? pagerDutyClientFor;
  const now = deps.now ?? (() => new Date());
  return {
    provider: "pagerduty",
    params: pagerDutyIncidentsParamsSchema,
    sampleInputs: { incident: "P000000" },
    occurrence(inputs) {
      if (typeof inputs.incident !== "string" || inputs.incident === "")
        throw new Error("no incident id in the occurrence");
      return inputs.incident;
    },
    async poll(params, since) {
      const until = now().getTime() + UNTIL_MARGIN_MS;
      const from = Math.max(since.getTime() - POLL_OVERLAP_MS, until - MAX_RANGE_MS);
      const filters = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      ) as Record<string, string[]>;
      const incidents = await client().listIncidents({
        ...filters,
        // Every status, so an incident handled within one poll interval still
        // starts its run, as a push would; the workflow reads the status.
        statuses: ["triggered", "acknowledged", "resolved"],
        since: new Date(from).toISOString(),
        until: new Date(until).toISOString(),
      });
      return incidents.map((incident) => ({
        inputs: { incident: incident.id },
        at: new Date(incident.created_at),
      }));
    },
    // The run gets the incident id either way, so the webhook's copy of the
    // incident is read only to key it and to apply the same filters the poll
    // hands PagerDuty.
    async fromPush(params, event) {
      if (pagerDutyEventType(event) !== "incident.triggered") return null;
      const { data } = triggeredSchema.parse(event).event;
      const matches = (values: readonly string[] | undefined, ...found: string[]) =>
        values === undefined || found.some((value) => values.includes(value));
      if (
        !matches(params.service_ids, data.service.id) ||
        !matches(params.team_ids, ...data.teams.map((team) => team.id)) ||
        !matches(params.urgencies, data.urgency)
      )
        return null;
      return { inputs: { incident: data.id }, at: new Date(data.created_at) };
    },
    describe: ({ incident }) => ({ kind: "pagerduty", label: `pagerduty ${String(incident)}` }),
  };
}
