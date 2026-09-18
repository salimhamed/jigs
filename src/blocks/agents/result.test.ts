import { expect, test } from "vitest";
import {
  extractAgentSession,
  type StepGeneration,
  type StepUsage,
  toStepResult,
} from "./result.ts";

const usage = { inputTokens: 12, outputTokens: 34 } as unknown as StepUsage;

test("toStepResult maps text and usage into the uniform shape", () => {
  const generation: StepGeneration = { text: "done", usage };
  expect(toStepResult(generation, { parsed: true })).toEqual({
    text: "done",
    output: { parsed: true },
    usage,
  });
});

test("extractAgentSession reads the Claude sessionId", () => {
  expect(extractAgentSession("claude", { "claude-code": { sessionId: "s-42" } })).toEqual({
    harness: "claude",
    id: "s-42",
  });
});

test("extractAgentSession reads the Codex app-server threadId", () => {
  expect(extractAgentSession("codex", { "codex-app-server": { threadId: "t-7" } })).toEqual({
    harness: "codex",
    id: "t-7",
  });
});

test("extractAgentSession is best-effort: absent or malformed metadata yields undefined", () => {
  expect(extractAgentSession("claude", undefined)).toBeUndefined();
  expect(extractAgentSession("claude", {})).toBeUndefined();
  expect(extractAgentSession("codex", { "codex-app-server": { threadId: 9 } })).toBeUndefined();
  expect(extractAgentSession("claude", { "claude-code": { sessionId: "" } })).toBeUndefined();
});
