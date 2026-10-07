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
 * the turn runs, and every turn with the same name continues the same harness session.
 * `instructions` lead the first message when that session starts fresh, and are ignored once it
 * exists.
 */
export type TurnRequest = {
  harness: Harness;
  cwd: string;
  conversation: string;
  messages: ConversationMessage[];
  instructions?: string;
};

/** One answer the harness gave, and the uuids of the messages it answered, in order. */
export type TurnReply = {
  text: string;
  consumed: string[];
};

/**
 * How a turn ended. `finished` means the harness answered every message the turn accepted;
 * `stopped` means the turn was stopped and messages still queued were dropped. `consumed` lists
 * every message the harness took, in order: one not listed was never delivered.
 */
export type TurnResult = {
  outcome: "finished" | "stopped";
  replies: TurnReply[];
  consumed: string[];
};
