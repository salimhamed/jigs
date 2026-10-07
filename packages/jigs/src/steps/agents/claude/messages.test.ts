import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { claudeGeneration, claudeStreamParts } from "./messages.ts";

const sdk = (message: Record<string, unknown>) => message as unknown as SDKMessage;
const assistant = (...content: Record<string, unknown>[]) =>
  sdk({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: null });
const toolResults = (...content: Record<string, unknown>[]) =>
  sdk({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
const result = (message: Record<string, unknown>) => message as unknown as SDKResultMessage;
const success = (fields: Record<string, unknown> = {}) =>
  result({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "s-1",
    ...fields,
  });
const failure = (subtype: string, errors: string[]) =>
  result({ type: "result", subtype, is_error: true, errors, session_id: "s-1" });

test("assistant text, thinking and tool calls become stream parts in order", () => {
  const parts = claudeStreamParts();
  expect([
    ...parts(
      assistant(
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ),
    ),
  ]).toEqual([
    { type: "reasoning-delta", text: "plan" },
    { type: "text-delta", text: "Reading." },
    { type: "tool-call", toolCallId: "t1", toolName: "Read", input: { file_path: "a.ts" } },
  ]);
});

test("a tool result carries the name of its call, and an error result is a tool error", () => {
  const parts = claudeStreamParts();
  [...parts(assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }))];
  expect([
    ...parts(
      toolResults(
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.ts" }] },
        { type: "tool_result", tool_use_id: "t2", content: "no such file", is_error: true },
      ),
    ),
  ]).toEqual([
    { type: "tool-result", toolCallId: "t1", toolName: "Bash", output: "a.ts" },
    { type: "tool-error", toolCallId: "t2", toolName: "unknown", error: "no such file" },
  ]);
});

test("a tool error or result that is not all text is a string with placeholders", () => {
  const parts = claudeStreamParts();
  const content = [
    { type: "text", text: "failed:" },
    { type: "image", source: {} },
  ];
  expect([
    ...parts(
      toolResults(
        { type: "tool_result", tool_use_id: "t1", content, is_error: true },
        { type: "tool_result", tool_use_id: "t2", content },
      ),
    ),
  ]).toEqual([
    { type: "tool-error", toolCallId: "t1", toolName: "unknown", error: "failed:\n[image]" },
    { type: "tool-result", toolCallId: "t2", toolName: "unknown", output: "failed:\n[image]" },
  ]);
});

test("text blocks in a row are separated, and text after any other part is not", () => {
  const parts = claudeStreamParts();
  expect([
    ...parts(assistant({ type: "text", text: "Done." })),
    ...parts(assistant({ type: "text", text: "Next" })),
    ...parts(assistant({ type: "tool_use", id: "t1", name: "Read", input: {} })),
    ...parts(assistant({ type: "text", text: "After." })),
    ...parts(assistant({ type: "thinking", thinking: "hm" }, { type: "text", text: "Last." })),
  ]).toEqual([
    { type: "text-delta", text: "Done." },
    { type: "text-delta", text: "\n\nNext" },
    { type: "tool-call", toolCallId: "t1", toolName: "Read", input: {} },
    { type: "text-delta", text: "After." },
    { type: "reasoning-delta", text: "hm" },
    { type: "text-delta", text: "Last." },
  ]);
});

test("a user message with plain text and every other message add nothing", () => {
  const parts = claudeStreamParts();
  expect([
    ...parts(sdk({ type: "user", message: { role: "user", content: "hi" } })),
    ...parts(sdk({ type: "system", subtype: "init", session_id: "s-1" })),
    ...parts(success()),
  ]).toEqual([]);
});

test("a successful result is the reply text and the session", () => {
  expect(claudeGeneration(success(), false)).toEqual({
    text: "done",
    providerMetadata: { claude: { sessionId: "s-1" } },
  });
});

test("a structured result answers with the structured output as its text", () => {
  expect(claudeGeneration(success({ structured_output: { ok: true } }), true)).toEqual({
    text: '{"ok":true}',
    output: { ok: true },
    providerMetadata: { claude: { sessionId: "s-1" } },
  });
});

test("a structured call whose result has no structured output fails, even with JSON in the reply", () => {
  expect(() => claudeGeneration(success({ result: '{"ok":true}' }), true)).toThrow(
    "Claude Code returned no structured output for the requested schema",
  );
});

test("an error result fails with its errors and the kind of the last assistant error", () => {
  expect(() =>
    claudeGeneration(failure("error_max_turns", ["Reached maximum number of turns (1)"]), false),
  ).toThrow("Claude Code failed: Reached maximum number of turns (1)");
  expect(() =>
    claudeGeneration(
      success({ is_error: true, result: "Invalid API key · Please run /login" }),
      false,
      "authentication_failed",
    ),
  ).toThrow("Claude Code failed (authentication_failed): Invalid API key · Please run /login");
  expect(() => claudeGeneration(failure("error_max_structured_output_retries", []), true)).toThrow(
    "could not produce output matching the schema",
  );
});
