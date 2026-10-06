// The `pagerduty.incidents` source: every new incident is one occurrence,
// keyed by its incident id, read off the `incident.triggered` event the hub
// passes on.

import { z } from "zod";
import {
  type PagerDutyIncidentsParams,
  pagerDutyIncidentsParamsSchema,
} from "../workflow/pagerduty/source.ts";
import type { Source } from "./event-triggers/sources.ts";

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

const pagerDutyEventType = (event: unknown): string | undefined =>
  eventTypeSchema.safeParse(event).data?.event.event_type;

export const PAGERDUTY_INCIDENTS: Source<PagerDutyIncidentsParams> = {
  provider: "pagerduty",
  params: pagerDutyIncidentsParamsSchema,
  sampleInputs: { installationName: "acme", incident: "P000000" },
  // The run gets only the incident id, so the event's copy of the incident
  // is read only to key it and to apply the trigger's filters.
  async fromPush(params, { installationName, payload: event }) {
    if (installationName !== params.installationName) return null;
    if (pagerDutyEventType(event) !== "incident.triggered") return null;
    // A shape PagerDuty will send the same way every time is no reason to retry.
    const triggered = triggeredSchema.safeParse(event);
    if (!triggered.success) {
      console.error(
        `[pagerduty] ignored an incident.triggered it could not read: ${triggered.error.message}`,
      );
      return null;
    }
    const { data } = triggered.data.event;
    const matches = (values: readonly string[] | undefined, ...found: string[]) =>
      values === undefined || found.some((value) => values.includes(value));
    if (
      !matches(params.services, data.service.id) ||
      !matches(params.teams, ...data.teams.map((team) => team.id)) ||
      !matches(params.urgencies, data.urgency)
    )
      return null;
    return {
      key: data.id,
      inputs: { installationName, incident: data.id },
      at: new Date(data.created_at),
    };
  },
  describe: ({ incident }) => `pagerduty ${String(incident)}`,
};
