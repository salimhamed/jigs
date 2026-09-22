import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { reducePiJsonl } from "./pi-jsonl.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("plain pi JSONL reduces the authoritative final message and exposes deltas", () => {
  const onDelta = vi.fn();
  const generation = reducePiJsonl(fixture("pi-plain.jsonl"), onDelta);

  expect(generation).toEqual({
    text: "Hello world",
    providerMetadata: { pi: { sessionId: "session-plain" } },
  });
  expect(onDelta).toHaveBeenCalledTimes(2);
  expect(onDelta).toHaveBeenNthCalledWith(1, {
    type: "text_delta",
    contentIndex: 0,
    delta: "Hello",
  });
});

test("submit_result arguments become the structured generation output", () => {
  expect(reducePiJsonl(fixture("pi-submit-result.jsonl"))).toMatchObject({
    text: "",
    output: { word: "sky", count: 3 },
    providerMetadata: { pi: { sessionId: "session-submit" } },
  });
});

test("a native retry after submit_result preserves the run's structured output", () => {
  expect(reducePiJsonl(fixture("pi-submit-result-retry.jsonl"))).toMatchObject({
    text: "follow-up recovered",
    output: { word: "sky", count: 3 },
    providerMetadata: { pi: { sessionId: "session-submit-retry" } },
  });
});

test("a message_end error fails even though pi exits zero", () => {
  expect(() => reducePiJsonl(fixture("pi-error.jsonl"))).toThrow(
    "model server rejected the request",
  );
});

test("a tool failure can continue to a successful settled assistant response", () => {
  expect(reducePiJsonl(fixture("pi-tool-continuation.jsonl"))).toMatchObject({
    text: "Recovered after the tool error",
  });
});

test("a recovered native retry uses the newer successful outcome", () => {
  expect(reducePiJsonl(fixture("pi-retry-success.jsonl"))).toMatchObject({
    text: "retry recovered",
    providerMetadata: { pi: { sessionId: "session-retry" } },
  });
});

test("an exhausted native retry reports the final model error", () => {
  expect(() => reducePiJsonl(fixture("pi-retry-exhausted.jsonl"))).toThrow(
    "provider remained unavailable",
  );
});

test("a settled aborted response fails", () => {
  expect(() => reducePiJsonl(fixture("pi-aborted.jsonl"))).toThrow("operation cancelled");
});

test("agent_end without agent_settled is not completion", () => {
  expect(() =>
    reducePiJsonl(
      '{"type":"agent_start"}\n{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}\n{"type":"agent_end","messages":[]}\n',
    ),
  ).toThrow("before the agent settled");
});

test("a new agent_start invalidates an earlier settlement", () => {
  expect(() =>
    reducePiJsonl(
      '{"type":"agent_start"}\n{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}\n{"type":"agent_settled"}\n{"type":"agent_start"}\n',
    ),
  ).toThrow("before the agent settled");
});

test("a new operation cannot reuse structured output from an earlier settlement", () => {
  expect(() =>
    reducePiJsonl(
      [
        '{"type":"agent_start"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"submit","name":"submit_result"}],"stopReason":"toolUse"}}',
        '{"type":"tool_execution_end","toolName":"submit_result","result":{"details":{"old":true}},"isError":false}',
        '{"type":"agent_settled"}',
        '{"type":"agent_start"}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"read","name":"read"}],"stopReason":"toolUse"}}',
        '{"type":"agent_settled"}',
      ].join("\n"),
    ),
  ).toThrow("unresolved tool-only response");
});

test("settlement without a final assistant response fails", () => {
  expect(() => reducePiJsonl('{"type":"agent_start"}\n{"type":"agent_settled"}\n')).toThrow(
    "without a final assistant message",
  );
});

test("a truncated final response fails", () => {
  expect(() =>
    reducePiJsonl(
      '{"type":"agent_start"}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"length"}}\n{"type":"agent_settled"}\n',
    ),
  ).toThrow("final response was truncated");
});

test("an unresolved tool-only final response fails", () => {
  expect(() =>
    reducePiJsonl(
      '{"type":"agent_start"}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call","name":"read"}],"stopReason":"toolUse"}}\n{"type":"agent_settled"}\n',
    ),
  ).toThrow("unresolved tool-only response");
});

test("malformed or truncated JSONL fails at the incomplete line", () => {
  expect(() => reducePiJsonl('{"type":"agent_start"}\n{"type":"message_end"')).toThrow(
    "invalid JSON event on line 2",
  );
});

test("a syntactically valid non-event line fails", () => {
  expect(() => reducePiJsonl('{"type":"agent_start"}\nnull\n')).toThrow(
    "invalid JSON event on line 2",
  );
});
