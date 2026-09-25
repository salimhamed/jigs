import { expect, test } from "vitest";
import { extractAgentSession, type ModelGeneration, toModelResult } from "./result.ts";

test("toModelResult maps text and structured output into the uniform shape", () => {
  const generation: ModelGeneration = { text: "done" };
  expect(toModelResult(generation, { parsed: true })).toEqual({
    text: "done",
    output: { parsed: true },
  });
});

test("toModelResult omits the output when no structured answer was requested", () => {
  const result = toModelResult({ text: "done" }, undefined);
  expect(result).toEqual({ text: "done", output: undefined });
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
