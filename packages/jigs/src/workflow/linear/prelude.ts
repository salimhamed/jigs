import type { fetchTicketSnapshot } from "../../steps/linear/fetch-snapshot.ts";
import type { resolveLinearIssue } from "../../steps/linear/resolve.ts";
import { claimTicket, type TicketClaim } from "./claim.ts";
import type { TicketSnapshot } from "./snapshot.ts";

/**
 * Durable ticket lookups required before a workflow starts protected work.
 *
 * @group Factory plumbing
 */
export interface AcquireTicketSteps {
  resolveLinearIssue: typeof resolveLinearIssue;
  fetchTicketSnapshot: typeof fetchTicketSnapshot;
}

/**
 * Resolve a ticket reference in the Linear installation `installationName` names, claim it, and
 * read its current requirements.
 * Provisioning and all other protected work deliberately happen after this routine.
 */
export async function acquireTicket(
  { installationName, reference }: { installationName: string; reference: string },
  steps: AcquireTicketSteps,
): Promise<{ claim: TicketClaim; snapshot: TicketSnapshot }> {
  const issue = await steps.resolveLinearIssue({ installationName, reference });
  const claim = await claimTicket({
    installationName,
    issueId: issue.id,
    identifier: issue.identifier,
  });
  const snapshot = await steps.fetchTicketSnapshot({ installationName, issueId: issue.id });
  return { claim, snapshot };
}
