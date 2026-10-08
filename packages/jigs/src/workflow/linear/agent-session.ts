// What workflow code and the Linear agent steps share about a Linear agent
// session: the hook tokens a run holds for it, and the activities it posts
// and reads.

import type { ConversationMessage } from "../agents/conversation.ts";
import type { Harness } from "../agents/harness-config.ts";
import { LINEAR_LISTENING_TOKEN_PREFIX, LINEAR_SESSION_TOKEN_PREFIX } from "../hook-tokens.ts";

/**
 * Build the hook token that makes one run the owner of a Linear agent session in one Linear
 * installation. Its live turn is registered under it.
 *
 * @remarks
 * The run creates this hook once and holds it for its whole life, as a ticket claim is held:
 * holding it makes the run the session's one owner, and it is how the service finds that run.
 * Nothing wakes it; a run reads the session through {@link linearListeningToken}.
 */
export function linearSessionToken(installationName: string, sessionId: string): string {
  return `${LINEAR_SESSION_TOKEN_PREFIX}${installationName}:${sessionId}`;
}

/**
 * Build the hook token a run holds while it reads what people send in a Linear agent session.
 *
 * @remarks
 * The service wakes it for each message. A message that arrives while the session's owner holds
 * no such hook is not read until the run listens again. Before every wait on it, the run reads
 * the session's prompts again, because a wake carries nothing and a reply that arrived before
 * the hook existed woke no one.
 */
export function linearListeningToken(installationName: string, sessionId: string): string {
  return `${LINEAR_LISTENING_TOKEN_PREFIX}${installationName}:${sessionId}`;
}

/**
 * What the factory's app posts into a Linear agent session. A `thought` or an `action` shows
 * progress; an `elicitation` asks the person for input; a `response` or an `error` ends the
 * app's turn, and Linear waits for the person.
 *
 * @group Linear agent sessions
 */
export type LinearAgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "elicitation"; body: string }
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

/**
 * One turn of a conversation in a Linear agent session: the harness and worktree it runs in, the
 * mention that opened the session until a turn takes it, and `consumed`, the ids of the messages
 * earlier turns took. The turn takes every newer reply in the session.
 */
export type LinearAgentTurnRequest = {
  installationName: string;
  sessionId: string;
  harness: Harness;
  cwd: string;
  instructions?: string;
  opening?: ConversationMessage;
  consumed: string[];
};

/** The `once` key of the final response that answers a stop, whoever posts it. */
export const stopAnswerKey = (stopId: string) => `stopped:${stopId}`;
