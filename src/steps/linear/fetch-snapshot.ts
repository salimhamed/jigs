// Wrapped as a step by the factory, so each fetch is its own memoized step
// record and the World's step history *is* the versioned audit trail — there
// is no jigs-owned snapshot store. On resume the launch-time copy comes back
// from the record and the new fetch is genuinely fresh, which is why a human's
// unblocking reply appears in the later version without any special handling.

import { fetchIssueSnapshot } from "../../providers/linear.ts";
import { type TicketSnapshot, toTicketSnapshot } from "../../workflow/linear/snapshot.ts";

/** Read the ticket’s current details and discussion. */
export async function fetchTicketSnapshot(issueId: string): Promise<TicketSnapshot> {
  const raw = await fetchIssueSnapshot(issueId);
  const snapshot = toTicketSnapshot(raw, new Date().toISOString());
  console.log(
    `[snapshot] fetched issue=${issueId} identifier=${raw.identifier} state=${snapshot.state} labels=${snapshot.labels.length === 0 ? "none" : snapshot.labels.join(",")} comments=${snapshot.comments.length}`,
  );
  return snapshot;
}
