import { type ModelMessage, type Tool, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { expect, test } from "vitest";
import { z } from "zod";
import { answerThread, slackSystemPrompt } from "./agent";

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const says = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USAGE,
  warnings: [],
});

const calls = (toolName: string, input: unknown) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USAGE,
  warnings: [],
});

function listRunsTool(answer: unknown): Record<string, Tool> {
  return {
    list_runs: tool({
      description: "the runs",
      inputSchema: z.object({ status: z.string().optional() }),
      execute: async () => answer,
    }),
  };
}

test("the model's answer is the reply", async () => {
  const model = new MockLanguageModelV3({ doGenerate: [says(" two runs. ")] });
  expect(
    await answerThread([{ role: "user", content: "what is running?" }], {
      model,
      tools: {},
      pipelines: ["ticket"],
    }),
  ).toBe("two runs.");
});

test("a tool call is executed and its result fed back for the answer", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: [
      calls("list_runs", { status: "suspended" }),
      says("one run is suspended: wrun_01J."),
    ],
  });
  const reply = await answerThread([{ role: "user", content: "parked?" }], {
    model,
    tools: listRunsTool({ total: 1, runs: [{ runId: "wrun_01J" }] }),
    pipelines: ["ticket"],
  });
  expect(reply).toBe("one run is suspended: wrun_01J.");
  expect(model.doGenerateCalls).toHaveLength(2);
});

test("the loop stops at its step ceiling rather than calling tools forever", async () => {
  // Every turn is another tool call: without stopWhen this never returns.
  const model = new MockLanguageModelV3({
    doGenerate: async () => calls("list_runs", {}),
  });
  const reply = await answerThread([{ role: "user", content: "loop" }], {
    model,
    tools: listRunsTool({ total: 0, runs: [] }),
    pipelines: ["ticket"],
    maxSteps: 3,
  });
  expect(model.doGenerateCalls).toHaveLength(3);
  expect(reply).toContain("ran out of steps");
});

test("the thread and the factory's pipelines are what the model is given", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async () => says("ok") });
  const thread: ModelMessage[] = [
    { role: "user", content: "what can you run?" },
    { role: "assistant", content: "two pipelines." },
    { role: "user", content: "and now?" },
  ];
  await answerThread(thread, {
    model,
    tools: listRunsTool({}),
    pipelines: ["ticket", "nightly"],
  });

  const seen = model.doGenerateCalls[0];
  const system = seen?.prompt.find((message) => message.role === "system");
  expect(String(system?.content)).toContain("ticket, nightly");
  expect(seen?.prompt.filter((m) => m.role !== "system")).toHaveLength(3);
  expect(seen?.tools?.map((t) => t.name)).toEqual(["list_runs"]);
});

test("a model call that fails rejects, so the dispatcher can say so in the thread", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: () => Promise.reject(new Error("openrouter said 402")),
  });
  await expect(
    answerThread([{ role: "user", content: "hi" }], {
      model,
      tools: {},
      pipelines: [],
    }),
  ).rejects.toThrow("openrouter said 402");
});

test("a provider that never answers is aborted, so the thread's queue is not held open", async () => {
  // The whole mechanism is the abort signal generateText arms from `timeout`
  // and hands the provider — a real one passes it to fetch. Without it this
  // hangs, and every later message in that conversation hangs behind it.
  const model = new MockLanguageModelV3({
    doGenerate: ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () =>
          reject(new Error("aborted by the caller")),
        );
      }),
  });
  await expect(
    answerThread([{ role: "user", content: "hi" }], {
      model,
      tools: {},
      pipelines: [],
      timeoutMs: 20,
    }),
  ).rejects.toThrow();
});

test("a thread with nothing readable in it is answered without paying a model", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => says("should never run"),
  });
  const reply = await answerThread([], {
    model,
    tools: {},
    pipelines: ["ticket"],
  });
  expect(model.doGenerateCalls).toEqual([]);
  expect(reply).toContain("nothing for me to read");
});

test("the prompt forbids the four things a wrong answer would come from", () => {
  const prompt = slackSystemPrompt(["ticket"]);
  expect(prompt).toContain("ticket");
  expect(prompt).toMatch(/never invent/i);
  expect(prompt).toMatch(/ask for it/i);
  expect(prompt).toMatch(/explicitly asked/i);
  expect(prompt).toMatch(/no markdown/i);
});

test("a thread that belongs to a run says so, so 'cancel it' resolves without an id", () => {
  const prompt = slackSystemPrompt(["ticket"], {
    runId: "wrun_01J",
    pipeline: "ticket",
    status: "suspended",
  });
  expect(prompt).toContain(
    "This thread belongs to run wrun_01J (pipeline ticket, status suspended)",
  );
  expect(prompt).toMatch(/read the run with the tools/i);
});

test("a thread that belongs to no run claims none", () => {
  expect(slackSystemPrompt(["ticket"])).not.toContain("This thread belongs to");
  expect(slackSystemPrompt(["ticket"], null)).not.toContain(
    "This thread belongs to",
  );
});

test("the run a thread belongs to reaches the model's system prompt", async () => {
  const model = new MockLanguageModelV3({ doGenerate: [says("cancelled it")] });
  await answerThread([{ role: "user", content: "cancel it" }], {
    model,
    tools: {},
    pipelines: ["ticket"],
    run: { runId: "wrun_01J", pipeline: "ticket", status: "running" },
  });
  expect(model.doGenerateCalls[0]?.prompt[0]?.content).toContain(
    "This thread belongs to run wrun_01J",
  );
});
