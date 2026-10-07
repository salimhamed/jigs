import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeDriverDependencies, ClaudeQuery } from "./driver.ts";

export type ClaudeQueryCall = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
};

/** A successful result message, with the reply text and session given. */
export function claudeResult(fields: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "claude-session",
    ...fields,
  } as unknown as SDKMessage;
}

/**
 * A stand-in for the SDK's `query` that records each call and answers with `reply`'s messages,
 * a successful result by default.
 */
export function fakeClaudeQuery(
  reply: (call: ClaudeQueryCall) => AsyncIterable<SDKMessage> | Iterable<SDKMessage> = () => [
    claudeResult(),
  ],
): ClaudeDriverDependencies["query"] & { calls: ClaudeQueryCall[] } {
  const calls: ClaudeQueryCall[] = [];
  const query = (call: ClaudeQueryCall): ClaudeQuery => {
    calls.push(call);
    const messages = (async function* () {
      yield* reply(call);
    })();
    return Object.assign(messages, { interrupt: async () => undefined, close: () => {} });
  };
  return Object.assign(query, { calls });
}

/** A promise a test settles by hand. */
export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function textOf(message: SDKUserMessage): string {
  const { content } = message.message;
  return typeof content === "string" ? content : JSON.stringify(content);
}

const uuidOf = (message: SDKUserMessage) => (message as { uuid?: string }).uuid ?? "";

/** What {@link fakeClaudeCli} saw. */
export interface FakeClaudeCli {
  query: ClaudeDriverDependencies["query"];
  calls: ClaudeQueryCall[];
  /** Every user message it read, in order. */
  received: { uuid: string; text: string }[];
  interrupts: unknown[];
}

/** How {@link fakeClaudeCli} behaves. Turns count from 1. */
export interface FakeClaudeScript {
  /** Holds the first turn back, as Claude Code's startup does. Queued messages wait. */
  startup?: Promise<void>;
  midTurn?(turn: number): Promise<void> | void;
  beforeResult?(turn: number): void;
  /** Ends the turn with an error result. */
  fail?(turn: number): boolean;
  /** Fails the process as the turn starts. */
  crash?(turn: number): boolean;
  /** Leaves `user_message_uuids` off every result. */
  omitUuids?: boolean;
  /** Ignores interrupts and answers them with no receipt, as an older CLI would. */
  deaf?: boolean;
}

/**
 * A stand-in for Claude Code under streaming input. Each turn takes every queued message,
 * reports one tool call, waits on `midTurn`, folds in whatever arrived meanwhile and ends with a
 * result naming the uuids it consumed. An interrupt with `cancelQueued` drops what is queued and
 * lists it as cancelled; one during `midTurn` also ends that turn with an error result.
 */
export function fakeClaudeCli(script: FakeClaudeScript = {}): FakeClaudeCli {
  const calls: ClaudeQueryCall[] = [];
  const received: FakeClaudeCli["received"] = [];
  const interrupts: unknown[] = [];
  const query = (call: ClaudeQueryCall): ClaudeQuery => {
    calls.push(call);
    const inbox: SDKUserMessage[] = [];
    let inputDone = false;
    let closed = false;
    let wake: (() => void) | undefined;
    let abort: (() => void) | undefined;
    let shut!: () => void;
    const closing = new Promise<void>((resolve) => {
      shut = resolve;
    });
    void (async () => {
      if (typeof call.prompt === "string") throw new Error("expected streaming input");
      for await (const message of call.prompt) {
        inbox.push(message);
        received.push({ uuid: uuidOf(message), text: textOf(message) });
        wake?.();
      }
      inputDone = true;
      wake?.();
    })();
    const messages = (async function* (): AsyncGenerator<SDKMessage> {
      let turn = 0;
      if (script.startup !== undefined) await Promise.race([script.startup, closing]);
      for (;;) {
        while (inbox.length === 0 && !inputDone && !closed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (closed || inbox.length === 0) return;
        const consumed = inbox.splice(0).map(uuidOf);
        turn += 1;
        if (script.crash?.(turn) === true) throw new Error("Claude Code process failed");
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "tool_use", id: `tool-${turn}`, name: "Bash", input: {} }],
          },
        } as unknown as SDKMessage;
        let aborted = false;
        await Promise.race([
          script.midTurn?.(turn),
          new Promise<void>((resolve) => {
            abort = () => {
              aborted = true;
              resolve();
            };
          }),
        ]);
        abort = undefined;
        if (closed) return;
        const uuids = (list: string[]) => (script.omitUuids ? {} : { user_message_uuids: list });
        if (aborted) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["interrupted"],
            session_id: "claude-session",
            ...uuids(consumed),
          } as unknown as SDKMessage;
          continue;
        }
        await settle();
        consumed.push(...inbox.splice(0).map(uuidOf));
        script.beforeResult?.(turn);
        await settle();
        yield script.fail?.(turn) === true
          ? claudeResult({
              subtype: "error_max_turns",
              is_error: true,
              errors: ["Reached maximum number of turns (1)"],
              ...uuids(consumed),
            })
          : claudeResult({ result: `reply ${turn}`, ...uuids(consumed) });
      }
    })();
    return Object.assign(messages, {
      interrupt: async (options?: { cancelQueued?: boolean }) => {
        interrupts.push(options);
        if (script.deaf) return undefined;
        const cancelled = options?.cancelQueued === true ? inbox.splice(0).map(uuidOf) : [];
        abort?.();
        return { still_queued: [], cancelled };
      },
      close: () => {
        closed = true;
        shut();
        wake?.();
        abort?.();
      },
    });
  };
  return { query, calls, received, interrupts };
}
