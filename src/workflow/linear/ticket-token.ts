// Kept out of claim.ts, which imports the Workflow SDK, so the CLI can read a
// claim token without bundling the SDK.

/** Prefix for the durable hook that gives one run exclusive ownership of a ticket. */
export const TICKET_TOKEN_PREFIX = "linear:ticket:";

/** Build the durable hook token for a Linear issue ID. */
export function ticketToken(issueId: string): string {
  return `${TICKET_TOKEN_PREFIX}${issueId}`;
}
