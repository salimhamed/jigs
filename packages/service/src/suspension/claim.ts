import { createHook, type Hook } from "workflow";
import { suspensionMetadata } from "./record";
import { ticketToken } from "./tokens";

export class ClaimConflictError extends Error {
  readonly resource: string;
  readonly owningRunId: string;

  constructor(resource: string, owningRunId: string) {
    super(
      `${resource} is already claimed by run ${owningRunId} — release it with: jigs cancel ${owningRunId}`,
    );
    this.name = "ClaimConflictError";
    this.resource = resource;
    this.owningRunId = owningRunId;
  }
}

export interface TicketClaim {
  issueId: string;
  identifier: string;
  token: string;
  hook: Hook<unknown>;
}

// Must be the pipeline body's first await: getConflict() suspends to commit
// the hook registration, so a duplicate run fails in seconds, before any paid
// step. The hook is deliberately not `using`-scoped — it is held for the
// run's whole life (the SDK auto-disposes it at terminal state) and doubles
// as needsHuman()'s wake channel.
export async function claimTicket(
  issueId: string,
  identifier: string,
): Promise<TicketClaim> {
  if (typeof identifier !== "string" || identifier === "") {
    throw new TypeError(
      "claimTicket received a missing or empty identifier; AGE-346 changed claimTicket to require the injected Linear identifier as its second argument",
    );
  }
  const token = ticketToken(issueId);
  const identifierToken = ticketToken(identifier);
  const hook = createHook<unknown>({
    token,
    metadata: suspensionMetadata({
      key: "ticket-claim",
      reason: "one active run per ticket",
      satisfiedBy: token,
    }),
  });
  const conflict = await hook.getConflict();
  if (conflict !== null) {
    throw new ClaimConflictError(token, conflict.runId);
  }
  const identifierHook = createHook<unknown>({
    token: identifierToken,
    metadata: suspensionMetadata({
      key: "ticket-claim-alias",
      reason: "one active run per ticket",
      satisfiedBy: identifierToken,
    }),
  });
  const identifierConflict = await identifierHook.getConflict();
  if (identifierConflict !== null) {
    hook.dispose();
    throw new ClaimConflictError(identifierToken, identifierConflict.runId);
  }
  return { issueId, identifier, token, hook };
}
