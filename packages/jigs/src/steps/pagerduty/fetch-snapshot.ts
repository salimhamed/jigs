// Wrapped as a step by the factory, so each read is its own memoized record:
// every step in one activation sees the same incident, and a resumed run
// reads it afresh.

import { pagerDutyFor } from "../../providers/pagerduty.ts";
import { type IncidentSnapshot, toIncidentSnapshot } from "../../workflow/pagerduty/snapshot.ts";

/**
 * Read the incident once: its number, title, status, urgency, creation time, URL, service,
 * assignees and escalation policy.
 *
 * @group Read
 */
export async function fetchIncidentSnapshot({
  installationName,
  incidentId,
}: {
  installationName: string;
  incidentId: string;
}): Promise<IncidentSnapshot> {
  const raw = await pagerDutyFor(installationName).getIncident(incidentId);
  const snapshot = toIncidentSnapshot(raw, new Date().toISOString());
  console.log(
    `[incident snapshot] fetched incident=${incidentId} number=${snapshot.number} status=${snapshot.status} urgency=${snapshot.urgency} assignees=${snapshot.assignees.length}`,
  );
  return snapshot;
}
