import type { ConversationMessage } from "../../../workflow/agents/conversation.ts";

/** A conversation turn that is running in this process. */
export interface LiveTurn {
  /**
   * Queue a message into the running turn without interrupting it. Returns false once the turn
   * has begun to end: the message was not taken, and the next turn must send it.
   */
  inject(message: ConversationMessage): boolean;
  /** Interrupt the turn and drop the messages still queued. Safe to call more than once. */
  stop(): void;
}

// Keyed on globalThis because the service and a factory's step bundle can each
// load their own copy of this module, and the service must reach the step's turn.
const LIVE_TURNS = Symbol.for("jigs.liveTurns");

function turns(): Map<string, LiveTurn> {
  const holder = globalThis as { [LIVE_TURNS]?: Map<string, LiveTurn> };
  holder[LIVE_TURNS] ??= new Map();
  return holder[LIVE_TURNS];
}

/** Register the live turn of `conversation`, and return how to unregister it. */
export function registerLiveTurn(conversation: string, turn: LiveTurn): () => void {
  const live = turns();
  if (live.has(conversation)) {
    throw new Error(`conversation ${conversation} already has a live turn`);
  }
  live.set(conversation, turn);
  return () => {
    if (live.get(conversation) === turn) live.delete(conversation);
  };
}

/** The turn running for `conversation` in this process, if any. */
export function liveTurn(conversation: string): LiveTurn | undefined {
  return turns().get(conversation);
}
