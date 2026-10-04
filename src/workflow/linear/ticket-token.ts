// Kept out of claim.ts, which imports the Workflow SDK, so the CLI can build a
// claim token without bundling the SDK.

import { TICKET_TOKEN_PREFIX } from "../hook-tokens.ts";

/** Build the durable hook token for a Linear issue ID. */
export function ticketToken(issueId: string): string {
  return `${TICKET_TOKEN_PREFIX}${issueId}`;
}
