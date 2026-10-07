import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeDriverDependencies } from "./driver.ts";

export type ClaudeQueryCall = { prompt: string; options: Options };

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
  const query = (call: ClaudeQueryCall) => {
    calls.push(call);
    return (async function* () {
      yield* reply(call);
    })();
  };
  return Object.assign(query, { calls });
}
