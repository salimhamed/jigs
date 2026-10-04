import type { TextStreamPart, ToolSet } from "ai";
import { expect, test, vi } from "vitest";
import {
  type AgentStreamPart,
  openStepStream,
  type StepStream,
  teeAgentStream,
} from "./step-stream.ts";

const start = { harness: "claude", cwd: "/work/tree", resume: false } as const;

function recorder(fail?: (part: AgentStreamPart, index: number) => boolean): {
  stream: StepStream;
  parts: AgentStreamPart[];
  attempts: number;
} {
  const parts: AgentStreamPart[] = [];
  const state = { attempts: 0 };
  const writable = new WritableStream<AgentStreamPart>({
    write(part) {
      state.attempts++;
      if (fail?.(part, state.attempts - 1)) throw new Error("world down");
      parts.push(part);
    },
  });
  return {
    stream: { attempt: 2, writable },
    parts,
    get attempts() {
      return state.attempts;
    },
  };
}

async function* partsOf(parts: TextStreamPart<ToolSet>[]): AsyncGenerator<TextStreamPart<ToolSet>> {
  yield* parts;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const text = (delta: string) => ({ type: "text-delta", id: "t", text: delta }) as const;
const reasoning = (delta: string) => ({ type: "reasoning-delta", id: "r", text: delta }) as const;

test("each attempt opens with attempt-start, then deltas coalesce until a boundary", async () => {
  const { stream, parts } = recorder();

  await teeAgentStream(
    partsOf([
      reasoning("think"),
      reasoning("ing"),
      text("Hel"),
      text("lo"),
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "Bash",
        input: { command: "ls" },
        providerExecuted: true,
      } as TextStreamPart<ToolSet>,
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "Bash",
        input: { command: "ls" },
        output: "a.txt",
        providerExecuted: true,
      } as TextStreamPart<ToolSet>,
      text("done"),
      { type: "finish", finishReason: "stop" } as TextStreamPart<ToolSet>,
    ]),
    stream,
    start,
  );
  await settle();

  expect(parts).toEqual([
    { type: "attempt-start", attempt: 2, harness: "claude", cwd: "/work/tree", resume: false },
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "Hello" },
    { type: "tool-call", toolCallId: "c1", toolName: "Bash", input: '{"command":"ls"}' },
    { type: "tool-result", toolCallId: "c1", toolName: "Bash", output: "a.txt", isError: false },
    { type: "text", text: "done" },
    { type: "finish", finishReason: "stop" },
  ]);
  expect(stream.writable.locked).toBe(false);
});

test("buffered text is written after about a second, even while the agent is silent", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { stream, parts } = recorder();
    let resume = () => {};
    const toolCall = new Promise<void>((resolve) => {
      resume = resolve;
    });
    async function* agent(): AsyncGenerator<TextStreamPart<ToolSet>> {
      yield text("a");
      yield text("b");
      await toolCall;
      yield text("c");
    }

    const run = teeAgentStream(agent(), stream, start);
    await vi.advanceTimersByTimeAsync(999);
    expect(parts.slice(1)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(parts.slice(1)).toEqual([{ type: "text", text: "ab" }]);

    resume();
    await run;
    await vi.advanceTimersByTimeAsync(0);
    expect(parts.slice(1)).toEqual([
      { type: "text", text: "ab" },
      { type: "text", text: "c" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("tool payloads are truncated to a fixed cap with a marker", async () => {
  const { stream, parts } = recorder();
  const big = "x".repeat(10_000);

  await teeAgentStream(
    partsOf([
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "Read",
        input: {},
        output: big,
        providerExecuted: true,
      } as TextStreamPart<ToolSet>,
    ]),
    stream,
    start,
  );
  await settle();

  const result = parts[1] as Extract<AgentStreamPart, { type: "tool-result" }>;
  expect(result.output.length).toBeLessThan(4200);
  expect(result.output).toMatch(/^x+… \[truncated 5904 chars\]$/);
});

test("a failed write turns the stream off for the attempt and never fails the run", async () => {
  const sink = recorder((_part, index) => index === 1);

  await expect(
    teeAgentStream(
      partsOf([
        reasoning("a"),
        text("b"),
        reasoning("c"),
        text("d"),
        { type: "finish", finishReason: "stop" } as TextStreamPart<ToolSet>,
      ]),
      sink.stream,
      start,
    ),
  ).resolves.toBeUndefined();
  await settle();

  expect(sink.parts).toEqual([
    { type: "attempt-start", attempt: 2, harness: "claude", cwd: "/work/tree", resume: false },
  ]);
  expect(sink.attempts).toBeLessThan(6);
  expect(sink.stream.writable.locked).toBe(false);
});

test("a writer that never settles does not hold the run", async () => {
  const writable = new WritableStream<AgentStreamPart>({ write: () => new Promise(() => {}) });

  await teeAgentStream(partsOf([text("a"), text("b")]), { attempt: 1, writable }, start);

  expect(writable.locked).toBe(false);
});

test("a provider error part is recorded and rethrown as the same error", async () => {
  const { stream, parts } = recorder();
  const error = new Error("rate limited");

  await expect(
    teeAgentStream(
      partsOf([text("partial"), { type: "error", error } as TextStreamPart<ToolSet>]),
      stream,
      start,
    ),
  ).rejects.toBe(error);
  await settle();

  expect(parts.slice(1)).toEqual([
    { type: "text", text: "partial" },
    { type: "error", message: "rate limited" },
  ]);
  expect(stream.writable.locked).toBe(false);
});

test("without a step stream the run still reads to the end and rethrows", async () => {
  const error = new Error("boom");

  await expect(
    teeAgentStream(
      partsOf([text("a"), { type: "error", error } as TextStreamPart<ToolSet>]),
      undefined,
      start,
    ),
  ).rejects.toBe(error);
});

test("outside a workflow step there is no step stream", () => {
  expect(openStepStream()).toBeUndefined();
});
