import { expect, test } from "vitest";
import {
  extractAgentSession,
  type ModelGeneration,
  type ModelUsage,
  toModelResult,
} from "./result.ts";

const usage = { inputTokens: 12, outputTokens: 34 } as unknown as ModelUsage;

test("toModelResult maps text and usage into the uniform shape", () => {
  const generation: ModelGeneration = { text: "done", usage };
  expect(toModelResult(generation, { parsed: true })).toEqual({
    text: "done",
    output: { parsed: true },
    usage,
  });
});

test("toModelResult adds a supplied driver cost to usage", () => {
  const result = toModelResult({ text: "done", usage, costUsd: 1.25 }, undefined);
  expect(result.usage).toEqual({ ...usage, costUsd: 1.25 });
});

test("toModelResult omits an absent driver cost", () => {
  const result = toModelResult({ text: "done", usage }, undefined);
  expect(result.usage).toEqual(usage);
  expect(Object.hasOwn(result.usage ?? {}, "costUsd")).toBe(false);
});

test("toModelResult preserves a genuine zero driver cost", () => {
  const result = toModelResult({ text: "done", usage, costUsd: 0 }, undefined);
  expect(result.usage).toEqual({ ...usage, costUsd: 0 });
});

test("extractAgentSession reads the driver pointer", () => {
  expect(
    extractAgentSession(
      "claude",
      { "claude-code": { sessionId: "s-42" } },
      { providerKey: "claude-code", field: "sessionId" },
    ),
  ).toEqual({
    harness: "claude",
    id: "s-42",
  });
});

test("extractAgentSession reads the Codex app-server threadId", () => {
  expect(
    extractAgentSession(
      "codex",
      { "codex-app-server": { threadId: "t-7" } },
      { providerKey: "codex-app-server", field: "threadId" },
    ),
  ).toEqual({
    harness: "codex",
    id: "t-7",
  });
});

test("extractAgentSession is best-effort: absent or malformed metadata yields undefined", () => {
  const pointer = { providerKey: "claude-code", field: "sessionId" };
  expect(extractAgentSession("claude", undefined, pointer)).toBeUndefined();
  expect(extractAgentSession("claude", {}, pointer)).toBeUndefined();
  expect(
    extractAgentSession(
      "codex",
      { "codex-app-server": { threadId: 9 } },
      { providerKey: "codex-app-server", field: "threadId" },
    ),
  ).toBeUndefined();
  expect(
    extractAgentSession("claude", { "claude-code": { sessionId: "" } }, pointer),
  ).toBeUndefined();
  expect(
    extractAgentSession("claude", { "claude-code": { sessionId: "s" } }, undefined),
  ).toBeUndefined();
});
