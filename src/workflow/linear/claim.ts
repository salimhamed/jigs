import { createHook, type Hook } from "workflow";

// The claim's hook token names the ticket, never the run: owning it is the
// exclusivity lock. The Linear ingress, when on, has only a webhook payload to
// go on, so it reconstructs the token through ticketToken below — build and
// parse cannot drift while they share the one constructor. Linear Comment
// payloads carry issueId as a UUID, so the token does too.
/** Prefix for the durable hook that gives one run exclusive ownership of a ticket. */
export const TICKET_TOKEN_PREFIX = "linear:ticket:";

/** Build the durable hook token for a Linear issue ID. */
export function ticketToken(issueId: string): string {
  return `${TICKET_TOKEN_PREFIX}${issueId}`;
}

/** Derive a claimed ticket's hook token from a Linear comment webhook. */
export function tokenFromLinearPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { type, data } = payload as {
    type?: unknown;
    data?: { issueId?: unknown };
  };
  if (type !== "Comment") return null;
  const issueId = data?.issueId;
  if (typeof issueId !== "string" || issueId === "") return null;
  return ticketToken(issueId);
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
      `${resource} is already claimed by run ${owningRunId} — release it with: pnpm exec jigs cancel ${owningRunId}`,
    );
    this.name = "ClaimConflictError";
    this.resource = resource;
    this.owningRunId = owningRunId;
  }
}

/**
 * A ticket held exclusively by the current workflow run.
 *
 * @group Linear tickets
 */
export interface TicketClaim {
  issueId: string;
  identifier: string;
  token: string;
  hook: Hook<unknown>;
  /**
   * Every comment this run has posted on the ticket. A parked run skips these
   * when it looks for a human's reply.
   */
  postedCommentIds: string[];
}

// Must be the workflow body's first await: getConflict() suspends to commit
// the hook registration, so a duplicate run fails in seconds, before any paid
// step. The hook is deliberately not `using`-scoped — it is held for the
// run's whole life (the SDK auto-disposes it at terminal state) and doubles
// as haltForHuman()'s wake channel.
//
// One hook, on the issue's UUID: an operator naming a run by its ticket
// identifier is resolved through Linear by the run-ref resolver, so a second
// hook keyed on the identifier would index nothing.
/**
 * Claim a Linear ticket for the lifetime of the current workflow run.
 *
 * @group Linear tickets
 */
export async function claimTicket(issueId: string, identifier: string): Promise<TicketClaim> {
  const token = ticketToken(issueId);
  const hook = createHook<unknown>({ token });
  const conflict = await hook.getConflict();
  if (conflict !== null) {
    throw new ClaimConflictError(token, conflict.runId);
  }
  return { issueId, identifier, token, hook, postedCommentIds: [] };
}
