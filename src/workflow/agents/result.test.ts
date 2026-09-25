import { expect, test } from "vitest";
import { harnesses } from "./harness-config.ts";
import {
  describeHarness,
  extractAgentSession,
  type ModelGeneration,
  toModelResult,
} from "./result.ts";

const claude = harnesses.claude({ model: "sonnet" });
const codex = harnesses.codex({ model: "gpt" });

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

test("extractAgentSession reads the session reference the driver names", () => {
  expect(
    extractAgentSession(
      claude,
      { "claude-code": { sessionId: "s-42" } },
      { providerKey: "claude-code", field: "sessionId" },
    ),
  ).toEqual({
    harness: "claude",
    id: "s-42",
    descriptor: describeHarness(claude),
  });
});

test("extractAgentSession reads the Codex app-server threadId", () => {
  expect(
    extractAgentSession(
      codex,
      { "codex-app-server": { threadId: "t-7" } },
      { providerKey: "codex-app-server", field: "threadId" },
    ),
  ).toEqual({
    harness: "codex",
    id: "t-7",
    descriptor: describeHarness(codex),
  });
});

test("extractAgentSession is best-effort: absent or malformed metadata yields undefined", () => {
  const ref = { providerKey: "claude-code", field: "sessionId" };
  expect(extractAgentSession(claude, undefined, ref)).toBeUndefined();
  expect(extractAgentSession(claude, {}, ref)).toBeUndefined();
  expect(
    extractAgentSession(
      codex,
      { "codex-app-server": { threadId: 9 } },
      { providerKey: "codex-app-server", field: "threadId" },
    ),
  ).toBeUndefined();
  expect(extractAgentSession(claude, { "claude-code": { sessionId: "" } }, ref)).toBeUndefined();
  expect(
    extractAgentSession(claude, { "claude-code": { sessionId: "s" } }, undefined),
  ).toBeUndefined();
});

test("describeHarness ignores field order, including a nested model source", () => {
  const pi = harnesses.pi({ kind: "openrouter", model: "m", apiKeyEnv: "K" }, { thinking: "low" });
  const reordered = {
    thinking: "low",
    model: { apiKeyEnv: "K", model: "m", kind: "openrouter" },
    kind: "pi",
  };
  expect(describeHarness(reordered as typeof pi)).toBe(describeHarness(pi));
  expect(describeHarness(harnesses.claude({ model: "opus" }))).not.toBe(describeHarness(claude));
});

test("describeHarness includes every provider setting, so a changed one starts a session fresh", () => {
  const before = harnesses.claude({ model: "opus", maxTurns: 40, allowedTools: ["Read"] });
  const after = harnesses.claude({ model: "opus", maxTurns: 41, allowedTools: ["Read"] });
  expect(describeHarness(before)).not.toBe(describeHarness(after));
  expect(describeHarness(harnesses.codex({ model: "gpt", personality: "pragmatic" }))).not.toBe(
    describeHarness(harnesses.codex({ model: "gpt" })),
  );
});
