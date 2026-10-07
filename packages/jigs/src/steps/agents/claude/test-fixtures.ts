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
    return Object.assign(messages, { interrupt: async () => undefined });
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

/**
 * A stand-in for Claude Code under streaming input. Each turn takes every queued message,
 * reports one assistant message, waits on `midTurn`, folds in whatever arrived meanwhile and
 * ends with a result naming the uuids it consumed. An interrupt during `midTurn` ends the turn
 * with an error result, and with `cancelQueued` drops what is queued.
 */
export function fakeClaudeCli(
  script: { midTurn?(turn: number): Promise<void> | void; beforeResult?(turn: number): void } = {},
): FakeClaudeCli {
  const calls: ClaudeQueryCall[] = [];
  const received: FakeClaudeCli["received"] = [];
  const interrupts: unknown[] = [];
  const query = (call: ClaudeQueryCall): ClaudeQuery => {
    calls.push(call);
    const inbox: SDKUserMessage[] = [];
    let inputDone = false;
    let wake: (() => void) | undefined;
    let abort: (() => void) | undefined;
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
      for (;;) {
        while (inbox.length === 0 && !inputDone) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (inbox.length === 0) return;
        const consumed = inbox.splice(0).map(uuidOf);
        turn += 1;
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
        if (aborted) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["interrupted"],
            session_id: "claude-session",
            user_message_uuids: consumed,
          } as unknown as SDKMessage;
          continue;
        }
        await settle();
        consumed.push(...inbox.splice(0).map(uuidOf));
        script.beforeResult?.(turn);
        await settle();
        yield claudeResult({ result: `reply ${turn}`, user_message_uuids: consumed });
      }
    })();
    return Object.assign(messages, {
      interrupt: async (options?: { cancelQueued?: boolean }) => {
        interrupts.push(options);
        const cancelled = options?.cancelQueued === true ? inbox.splice(0).map(uuidOf) : [];
        abort?.();
        return { still_queued: [], cancelled };
      },
    });
  };
  return { query, calls, received, interrupts };
}
