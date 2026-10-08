import { TICKET_TOKEN_PREFIX } from "../hook-tokens.ts";

/** Build the durable hook token for a Linear issue ID in one Linear installation. */
export function ticketToken(installationName: string, issueId: string): string {
  return `${TICKET_TOKEN_PREFIX}${installationName}:${issueId}`;
}
