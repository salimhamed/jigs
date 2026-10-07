import type { ConversationMessage, TurnResult } from "../../../workflow/agents/conversation.ts";
import type { TurnEvent } from "../shared/types.ts";
import { failureText } from "./messages.ts";

/** What Claude is told when it resumes a turn the service died during. */
export const RESTART_NOTE =
  "The service restarted during this turn. Check where you got to and carry on.";

// The most uuids a result names; a longer batch is cut.
const UUID_CAP = 64;

/** Everything a conversation turn knows, as plain data. */
export interface TurnState {
  phase: "running" | "stopping" | "ended";
  resume: boolean;
  launched: boolean;
  /** Sent to Claude and not yet named by any result, in order. */
  pending: string[];
  consumed: string[];
  replies: string[];
  /** The restart note's uuid, when this turn replays one that died. */
  note?: string | undefined;
  /** The error the last assistant message carried. */
  errorKind?: string | undefined;
}

/** What opens a turn. `note` is the uuid the restart note gets if the turn is a replay. */
export interface TurnStart {
  messages: readonly ConversationMessage[];
  /** The uuids already in the session's transcript. */
  transcript: ReadonlySet<string>;
  instructions?: string | undefined;
  note: string;
}

/** What the turn's loop observes. */
export type TurnInput =
  | { type: "inject"; message: ConversationMessage }
  /** `withdrawn` are the messages taken back from the input before Claude read them. */
  | { type: "stop"; withdrawn: string[] }
  | { type: "launch" }
  | { type: "assistant"; error?: string | undefined }
  | { type: "result"; uuids?: string[] | undefined; answer?: string; failure?: string }
  /** The interrupt's receipt; `cancelled` is missing from a CLI that does not cancel. */
  | { type: "receipt"; cancelled?: string[] | undefined }
  | { type: "interrupt-failed" }
  | { type: "backstop" }
  /** The query failed or ended without a result; `cancelled` when the run was cancelled. */
  | { type: "crashed"; error: unknown; cancelled: boolean };

/** What the turn's loop must do, in order. */
export type TurnAction =
  | { type: "send"; uuid: string; text: string }
  | { type: "launch" }
  | { type: "interrupt" }
  | { type: "start-backstop" }
  | { type: "observe"; event: TurnEvent }
  /** Unregister the live turn, then close Claude's input. */
  | { type: "close" }
  | { type: "finish"; result: TurnResult }
  /** Fail the step with the error the query raised. */
  | { type: "rethrow"; error: unknown };

export interface TurnStep {
  state: TurnState;
  actions: TurnAction[];
}

const authored = (message: ConversationMessage) => `${message.author}: ${message.text}`;

/** Open a turn: send what Claude has not seen yet, after the restart note on a replay. */
export function startTurn(start: TurnStart): TurnStep {
  const { messages, transcript } = start;
  const resume = transcript.size > 0;
  const consumed = messages.filter((m) => transcript.has(m.uuid)).map((m) => m.uuid);
  const note = consumed.length > 0 ? start.note : undefined;
  const actions: TurnAction[] = [];
  if (note !== undefined) actions.push({ type: "send", uuid: note, text: RESTART_NOTE });
  let lead = resume ? undefined : start.instructions;
  for (const message of messages) {
    if (transcript.has(message.uuid)) continue;
    const text = lead === undefined ? authored(message) : `${lead}\n\n${authored(message)}`;
    actions.push({ type: "send", uuid: message.uuid, text });
    lead = undefined;
  }
  const pending = actions.flatMap((action) => (action.type === "send" ? [action.uuid] : []));
  const state: TurnState = {
    phase: "running",
    resume,
    launched: false,
    pending,
    consumed,
    replies: [],
    note,
  };
  return { state, actions };
}

function end(state: TurnState, result: TurnResult, before: TurnAction[] = []): TurnStep {
  return {
    state: { ...state, phase: "ended" },
    actions: [{ type: "close" }, ...before, { type: "finish", result }],
  };
}

const stopped = (state: TurnState) =>
  end(state, { outcome: "stopped", replies: state.replies, consumed: state.consumed });

const failed = (state: TurnState, error: string) =>
  end(state, { outcome: "failed", error, replies: state.replies, consumed: state.consumed });

const without = (list: string[], drop: readonly string[]) =>
  list.filter((uuid) => !drop.includes(uuid));

const none = (state: TurnState): TurnStep => ({ state, actions: [] });

/** Whether the turn still takes injected messages. */
export const accepting = (state: TurnState) => state.phase === "running";

/** Apply one input to a turn. */
export function step(state: TurnState, input: TurnInput): TurnStep {
  if (state.phase === "ended") return none(state);
  switch (input.type) {
    case "inject": {
      const { uuid } = input.message;
      if (!accepting(state) || state.pending.includes(uuid) || state.consumed.includes(uuid)) {
        return none(state);
      }
      return {
        state: { ...state, pending: [...state.pending, uuid] },
        actions: [{ type: "send", uuid, text: authored(input.message) }],
      };
    }
    case "stop": {
      if (state.phase !== "running") return none(state);
      // Unread messages are taken back: they would reach Claude after the interrupt and run as
      // a new turn.
      const next: TurnState = {
        ...state,
        phase: "stopping",
        pending: without(state.pending, input.withdrawn),
      };
      if (!state.launched) return stopped(next);
      return { state: next, actions: [{ type: "interrupt" }, { type: "start-backstop" }] };
    }
    case "launch":
      return { state: { ...state, launched: true }, actions: [{ type: "launch" }] };
    case "assistant":
      return none({ ...state, errorKind: input.error });
    case "result":
      return onResult(state, input);
    case "receipt": {
      if (state.phase !== "stopping" || input.cancelled === undefined) return none(state);
      const next = { ...state, pending: without(state.pending, input.cancelled) };
      // What is left is in the interrupted turn, whose result is still to come. Cancelled
      // messages end with no result at all.
      return next.pending.length === 0 ? stopped(next) : none(next);
    }
    case "interrupt-failed":
    case "backstop":
      return state.phase === "stopping" ? stopped(state) : none(state);
    case "crashed":
      if (state.phase === "stopping") return stopped(state);
      // Once an answer is out, a retry would give it again.
      if (state.replies.length === 0 || input.cancelled) {
        return {
          state: { ...state, phase: "ended" },
          actions: [{ type: "close" }, { type: "rethrow", error: input.error }],
        };
      }
      return failed(
        state,
        input.error instanceof Error ? input.error.message : String(input.error),
      );
  }
}

function onResult(state: TurnState, input: Extract<TurnInput, { type: "result" }>): TurnStep {
  const { uuids } = input;
  // Missing, or cut at the cap: everything sent so far counts as taken, so the turn cannot wait
  // for a result that will never come.
  const taken =
    uuids === undefined || uuids.length >= UUID_CAP
      ? state.pending
      : uuids.filter((uuid) => state.pending.includes(uuid));
  const next: TurnState = {
    ...state,
    pending: without(state.pending, taken),
    consumed: [...state.consumed, ...taken.filter((uuid) => uuid !== state.note)],
    replies: input.answer === undefined ? state.replies : [...state.replies, input.answer],
    errorKind: undefined,
  };
  if (state.phase === "stopping") return stopped(next);
  if (input.failure !== undefined) return failed(next, failureText(input.failure, state.errorKind));
  const reply: TurnAction = { type: "observe", event: { type: "reply", text: input.answer ?? "" } };
  if (next.pending.length > 0) return { state: next, actions: [reply] };
  return end(next, { outcome: "finished", replies: next.replies, consumed: next.consumed }, [
    reply,
  ]);
}
