import {
  claimTicket,
  renderTicketSnapshot,
  type TicketHandoff,
} from "@salimhamed/jigs/blocks/linear";
import type { WorkItem } from "#blocks/delivery/types";
import { fetchTicketSnapshot, resolveLinearIssue } from "#jigs";

/** Claim a Linear ticket and read its current requirements. */
export async function acquireLinearTicket(reference: string) {
  const issue = await resolveLinearIssue(reference);
  const claim = await claimTicket(issue.id, issue.identifier);
  const snapshot = await fetchTicketSnapshot(issue.id);
  return { claim, snapshot };
}

/** Keep the ticket requirements and implementation brief together for delivery. */
export function workItemFromHandoff(handoff: TicketHandoff): WorkItem {
  return {
    id: handoff.snapshot.id,
    key: handoff.snapshot.identifier,
    title: handoff.snapshot.title,
    url: handoff.snapshot.url,
    instructions: `${renderTicketSnapshot(handoff.snapshot)}\n\n## Implementation brief\n${handoff.brief}\n\nThe ticket requirements take precedence over the brief.`,
  };
}
