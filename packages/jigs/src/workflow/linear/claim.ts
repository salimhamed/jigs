import { describeHookToken } from "../hook-tokens.ts";

// The claim's hook token names the ticket, never the run: owning it is the
// exclusivity lock. Nothing wakes it.

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
