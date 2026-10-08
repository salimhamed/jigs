import { describeHookToken } from "../hook-tokens.ts";
import { ticketToken } from "./ticket-token.ts";

// The claim's hook token names the ticket, never the run: owning it is the
// exclusivity lock. A Linear event from the hub has only its payload to go on, so it reconstructs the token through ticketToken — build and parse
// cannot drift while they share the one constructor. Linear Comment payloads
// carry issueId as a UUID, so the token does too.

/** Derive a claimed ticket's hook token from a Linear comment event from an installation. */
export function tokenFromLinearPayload(installationName: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { type, data } = payload as {
    type?: unknown;
    data?: { issueId?: unknown };
  };
  if (type !== "Comment") return null;
  const issueId = data?.issueId;
  if (typeof issueId !== "string" || issueId === "") return null;
  return ticketToken(installationName, issueId);
}

/**
 * A ticket-claim failure that identifies the run already holding the ticket.
 *
 * @group Errors and utilities
 */
export class ClaimConflictError extends Error {
  readonly resource: string;
  readonly owningRunId: string;

  constructor(resource: string, owningRunId: string) {
    super(
      // Read in `jigs status`, where a hook token is an internal address.
      `${describeHookToken(resource).label} is already claimed by run ${owningRunId}, so cancel that run to release it with pnpm exec jigs cancel ${owningRunId}`,
    );
    this.name = "ClaimConflictError";
    this.resource = resource;
    this.owningRunId = owningRunId;
  }
}

/**
 * A ticket held exclusively by the current workflow run, with the Linear agent session the run
 * talks to people in.
 *
 * @group Linear tickets
 */
export interface TicketClaim {
  /** The Linear installation, as named on the hub, the ticket is reached through. */
  installationName: string;
  issueId: string;
  identifier: string;
  token: string;
  /** The Linear agent session this run asks its questions and posts its notes in. */
  sessionId: string;
  /** The messages in the session this run has already read. A later question skips them. */
  consumedPromptIds: string[];
}
