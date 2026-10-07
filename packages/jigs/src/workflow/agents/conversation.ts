import type { FailedCheck } from "../../checks/catalog.ts";
import type { Harness } from "./harness-config.ts";

// Type aliases, not interfaces: aliases carry an implicit index signature,
// which keeps step inputs and returns assignable to the SDK's Serializable types.

/** One message a person sent into a conversation. `uuid` is the caller's own id for it, a UUID. */
export type ConversationMessage = {
  uuid: string;
  author: string;
  text: string;
};

/**
 * One turn of a conversation with a harness: the messages that open it, in the worktree the
 * harness works in.
 *
 * @remarks
 * `conversation` names the conversation. It keys the live turn that accepts more messages while
 * the turn runs, and every turn with the same name continues the same harness session. That
 * session lives with the worktree, so a conversation keeps one `cwd` for its whole life.
 * `messages` holds at least one message. `instructions` lead the first message when the session
 * starts fresh, and are ignored once it exists.
 */
export type TurnRequest = {
  harness: Harness;
  cwd: string;
  conversation: string;
  messages: ConversationMessage[];
  instructions?: string;
};

/**
 * How a turn ended, with each answer the harness gave and `consumed`, every message it took, in
 * order: one not listed was never delivered. `finished` means it answered every message the turn
 * accepted. `stopped` means the turn was stopped and messages still queued were dropped. `failed`
 * means a turn ended in an error, which `error` describes; the messages after it were dropped.
 */
export type TurnResult =
  | { outcome: "finished" | "stopped"; replies: string[]; consumed: string[] }
  | { outcome: "failed"; error: string; replies: string[]; consumed: string[] };

/** What the turn step returns: the turn's result, or the just-in-time checks that failed. */
export type TurnStepResult = TurnResult | { jitFailure: FailedCheck[] };
