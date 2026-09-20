import type { fetchTicketSnapshot } from "../../steps/linear/fetch-snapshot.ts";
import type { resolveLinearIssue } from "../../steps/linear/resolve.ts";
import { claimTicket, type TicketClaim } from "./claim.ts";
import type { TicketSnapshot } from "./snapshot.ts";

/** Durable ticket lookups required before a workflow starts protected work. */
export interface AcquireTicketSteps {
  resolveLinearIssue: typeof resolveLinearIssue;
  fetchTicketSnapshot: typeof fetchTicketSnapshot;
}

/**
 * Resolve a ticket reference, claim it, and read its current requirements.
 * Provisioning and all other protected work deliberately happen after this block.
 */
export async function acquireTicket(
  reference: string,
  steps: AcquireTicketSteps,
): Promise<{ claim: TicketClaim; snapshot: TicketSnapshot }> {
  const issue = await steps.resolveLinearIssue(reference);
  const claim = await claimTicket(issue.id, issue.identifier);
  const snapshot = await steps.fetchTicketSnapshot(issue.id);
  return { claim, snapshot };
}
