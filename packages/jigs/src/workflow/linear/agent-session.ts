// What workflow code and the Linear agent steps share about a Linear agent
// session: the hook token a conversation holds, and the activities it posts
// and reads.

import { LINEAR_SESSION_TOKEN_PREFIX } from "../hook-tokens.ts";

/**
 * Build the hook token for a Linear agent session in one Linear installation. A run conversing in
 * the session holds it, and its live turn is registered under it.
 *
 * @remarks
 * The run must create this hook once, as its first wait, and hold it for the whole conversation,
 * as a ticket claim is held: that is what makes it the session's one owner, and why a run holding
 * it is not reported as waiting. Before every wait on it, the run reads the session's prompts
 * again, because a wake carries nothing and a reply that arrived before the hook existed woke no
 * one.
 */
export function linearSessionToken(installationName: string, sessionId: string): string {
  return `${LINEAR_SESSION_TOKEN_PREFIX}${installationName}:${sessionId}`;
}

/**
 * What the factory's app posts into a Linear agent session. A `thought` or an `action` shows
 * progress; a `response` or an `error` ends the app's turn, and Linear waits for the person.
 *
 * @group Linear agent sessions
 */
export type LinearAgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/**
 * One message a person sent into a Linear agent session, oldest first when listed.
 *
 * @remarks
 * `signal` is null for a plain reply and `"stop"` when the person pressed stop; Linear also names
 * `continue`, `auth` and `select`. `sourceCommentId` is the comment the reply was written as, and
 * is null for a stop.
 *
 * @group Linear agent sessions
 */
export type LinearAgentPrompt = {
  id: string;
  createdAt: string;
  body: string;
  signal: string | null;
  author: { id: string; name: string };
  sourceCommentId: string | null;
};
