import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import type { AgentStreamPart } from "../step-stream.ts";
import { reducePiJsonl } from "./pi-jsonl.ts";
import { createPiStreamTap } from "./pi-stream.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8");
const start = { harness: "pi", cwd: "/work/tree", resume: true } as const;
const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const delta = (type: string, text: string) => ({
  type: "message_update",
  assistantMessageEvent: { type, contentIndex: 0, delta: text },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  const parts: AgentStreamPart[] = [];
  const writable = new WritableStream<AgentStreamPart>({
    write(part) {
      parts.push(part);
    },
  });
  return { parts, writable, tap: createPiStreamTap({ attempt: 2, writable }, start) };
}

test("arbitrary chunk boundaries, CRLF and a final unterminated line preserve every delta", async () => {
  const { parts, writable, tap } = recorder();
  const output = jsonl(delta("text_delta", "Hello"), delta("text_delta", " world"));
  for (const character of output.replaceAll("\n", "\r\n")) tap.write(character);
  await tap.end();
  await settle();

  expect(parts).toEqual([
    { type: "attempt-start", attempt: 2, ...start },
    { type: "text", text: "Hello world" },
    { type: "finish", finishReason: "stop" },
  ]);
  expect(writable.locked).toBe(false);
});

test("the recorded plain response streams its deltas once", async () => {
  const { parts, tap } = recorder();
  tap.write(fixture("pi-plain"));
  await tap.end();
  await settle();

  expect(parts.slice(1)).toEqual([
    { type: "text", text: "Hello world" },
    { type: "finish", finishReason: "stop" },
  ]);
});

test("recorded submit_result calls and their accepted output are shown plainly", async () => {
  const { parts, tap } = recorder();
  tap.write(fixture("pi-submit-result"));
  await tap.end();
  await settle();

  expect(parts.slice(1)).toEqual([
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "submit_result",
      input: '{"word":"sky","count":3}',
    },
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "submit_result",
      output: JSON.stringify({
        content: [{ type: "text", text: "Structured result submitted" }],
        details: { word: "sky", count: 3 },
      }),
      isError: false,
    },
    { type: "finish", finishReason: "stop" },
  ]);
});

test("a recorded tool error remains a tool result and does not terminate the observer", async () => {
  const { parts, tap } = recorder();
  tap.write(fixture("pi-tool-continuation"));
  await tap.end();
  await settle();

  expect(parts.slice(1)).toEqual([
    { type: "tool-call", toolCallId: "call-1", toolName: "read", input: '{"path":"missing"}' },
    {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "read",
      output: '{"content":[{"type":"text","text":"not found"}]}',
      isError: true,
    },
    { type: "finish", finishReason: "stop" },
  ]);
});

test("thinking streams before completion while unsupported and malformed event shapes are ignored", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { parts, tap } = recorder();
    tap.write(
      `${jsonl(
        null,
        [],
        42,
        { type: "message_update", assistantMessageEvent: null },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 42 } },
        { type: "message_end", message: { role: "assistant", content: [null, {}] } },
        { type: "tool_execution_end", toolCallId: 42, toolName: "read" },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} },
        delta("toolcall_delta", '{"path":'),
        delta("thinking_delta", "Consider "),
        delta("thinking_delta", "the answer"),
      )}\n`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(parts.slice(1)).toEqual([{ type: "reasoning", text: "Consider the answer" }]);
    await tap.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(parts.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  } finally {
    vi.useRealTimers();
  }
});

test("the tap ignores invalid JSON while the unchanged reducer still rejects it", async () => {
  const { parts, tap } = recorder();
  const output = `not json\n${fixture("pi-plain")}`;
  expect(() => tap.write(output)).not.toThrow();
  expect(() => reducePiJsonl(output)).toThrow("pi emitted invalid JSON event on line 1");
  await tap.end(new Error("pi emitted invalid JSON event on line 1"));
  await settle();

  expect(parts.slice(1)).toEqual([
    { type: "text", text: "Hello world" },
    { type: "error", message: "pi emitted invalid JSON event on line 1" },
  ]);
});

test.each(["pi-retry-success", "pi-submit-result-retry"])(
  "%s produces no terminal part until the caller finishes reduction",
  async (name) => {
    const { parts, tap } = recorder();
    const output = fixture(name);
    tap.write(output);
    await settle();
    expect(parts.filter((part) => part.type === "finish" || part.type === "error")).toEqual([]);
    expect(() =>
      reducePiJsonl(output, { requireResult: name.includes("submit-result") }),
    ).not.toThrow();
    await tap.end();
    await settle();
    expect(parts.filter((part) => part.type === "finish" || part.type === "error")).toEqual([
      { type: "finish", finishReason: "stop" },
    ]);
  },
);
