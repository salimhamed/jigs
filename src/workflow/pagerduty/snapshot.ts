// The per-activation copy of a PagerDuty incident: the fields a triage needs
// to orient, read once. Alerts, log entries and past incidents are an agent's
// to fetch through the PagerDuty MCP server, not widened here.

import type { PagerDutyIncident, PagerDutyReference } from "../../providers/pagerduty.ts";

/**
 * A PagerDuty object an incident points at, such as its service or an assignee.
 *
 * @group PagerDuty incidents
 */
export type IncidentRef = {
  id: string;
  name: string;
  url: string | null;
};

/**
 * The incident as one workflow activation read it.
 *
 * @group PagerDuty incidents
 */
export type IncidentSnapshot = {
  fetchedAt: string;
  id: string;
  number: number;
  title: string;
  status: "triggered" | "acknowledged" | "resolved";
  urgency: "high" | "low";
  createdAt: string;
  url: string;
  service: IncidentRef;
  assignees: IncidentRef[];
  escalationPolicy: IncidentRef;
};

function toRef(reference: PagerDutyReference): IncidentRef {
  return {
    id: reference.id,
    name: reference.summary ?? reference.id,
    url: reference.html_url ?? null,
  };
}

/** Normalize a PagerDuty incident into the stable shape a workflow reads. */
export function toIncidentSnapshot(raw: PagerDutyIncident, fetchedAt: string): IncidentSnapshot {
  return {
    fetchedAt,
    id: raw.id,
    number: raw.incident_number,
    title: raw.title,
    status: raw.status,
    urgency: raw.urgency,
    createdAt: raw.created_at,
    url: raw.html_url,
    service: toRef(raw.service),
    assignees: raw.assignments.map((assignment) => toRef(assignment.assignee)),
    escalationPolicy: toRef(raw.escalation_policy),
  };
}
