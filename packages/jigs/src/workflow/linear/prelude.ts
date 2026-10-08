import { createHook } from "workflow";
import type { fetchTicketSnapshot } from "../../steps/linear/fetch-snapshot.ts";
import type { resolveLinearIssue } from "../../steps/linear/resolve.ts";
import type { LinearAgentConversationSteps } from "./agent-conversation.ts";
import { linearSessionToken } from "./agent-session.ts";
import { ClaimConflictError, type TicketClaim } from "./claim.ts";
import type { TicketSnapshot } from "./snapshot.ts";
import { ticketToken } from "./ticket-token.ts";

/**
 * Durable ticket and session operations required before a workflow starts protected work.
 *
 * @group Factory plumbing
 */
export interface AcquireTicketSteps
  extends Pick<
    LinearAgentConversationSteps,
    "postLinearAgentActivity" | "setLinearAgentSessionUrls"
  > {
  resolveLinearIssue: typeof resolveLinearIssue;
  fetchTicketSnapshot: typeof fetchTicketSnapshot;
  openLinearAgentSession(request: {
    installationName: string;
    issueId: string;
  }): Promise<{ sessionId: string }>;
}

/**
 * Resolve a ticket reference in the Linear installation `installationName` names, claim it, take
 * a Linear agent session on it, and read its current requirements. Provisioning and all other
 * protected work deliberately happen after this routine.
 *
 * @remarks
 * Pass `session` when a Linear agent session started the run, and the run talks in that one;
 * otherwise it opens its own. Either way the session links the run and says the run is working,
 * and the run holds it until it ends, so its questions and notes all land there.
 */
export async function acquireTicket(
  {
    installationName,
    reference,
    session,
  }: { installationName: string; reference: string; session?: string | undefined },
  steps: AcquireTicketSteps,
): Promise<{ claim: TicketClaim; snapshot: TicketSnapshot }> {
  const {
    fetchTicketSnapshot,
    openLinearAgentSession,
    postLinearAgentActivity,
    resolveLinearIssue,
    setLinearAgentSessionUrls,
  } = steps;
  const issue = await resolveLinearIssue({ installationName, reference });
  const issueId = issue.id;

  // Both hooks are held for the run's whole life and never awaited: holding
  // the ticket's is the one-run-per-ticket lock, and holding the session's is
  // how the service finds this run when someone writes in the session. The SDK
  // disposes them when the run ends. Each getConflict() suspends to commit its
  // hook, so a duplicate run fails before any paid step.
  const token = ticketToken(installationName, issueId);
  const ticketConflict = await createHook<unknown>({ token }).getConflict();
  if (ticketConflict !== null) throw new ClaimConflictError(token, ticketConflict.runId);

  const sessionId =
    session ?? (await openLinearAgentSession({ installationName, issueId })).sessionId;
  const sessionToken = linearSessionToken(installationName, sessionId);
  const sessionConflict = await createHook<unknown>({ token: sessionToken }).getConflict();
  if (sessionConflict !== null) throw new ClaimConflictError(sessionToken, sessionConflict.runId);
  const ref = { installationName, sessionId };
  if (session !== undefined) await setLinearAgentSessionUrls({ ...ref, urls: [] });
  await postLinearAgentActivity({
    ...ref,
    content: { type: "thought", body: `Working on ${issue.identifier}` },
  });

  const snapshot = await fetchTicketSnapshot({ installationName, issueId });
  const claim: TicketClaim = {
    installationName,
    issueId,
    identifier: issue.identifier,
    token,
    sessionId,
    consumedPromptIds: [],
  };
  return { claim, snapshot };
}
