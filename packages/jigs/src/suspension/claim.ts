import { createHook, type Hook } from "workflow";
import { suspensionMetadata } from "./record.ts";
import { ticketToken } from "./tokens.ts";

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
//
// One hook, on the issue's UUID: an operator naming a run by its ticket
// identifier is resolved through Linear by the run-ref resolver, so a second
// hook keyed on the identifier would index nothing.
export async function claimTicket(
  issueId: string,
  identifier: string,
): Promise<TicketClaim> {
  const token = ticketToken(issueId);
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
  return { issueId, identifier, token, hook };
}
