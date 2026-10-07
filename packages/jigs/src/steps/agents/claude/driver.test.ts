import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { harnesses } from "../../../workflow/agents/harness-config.ts";
import { buildAskAgentRequest } from "../../../workflow/agents/plan.ts";
import { createClaudeDriver } from "./driver.ts";
import { fakeClaudeQuery } from "./test-fixtures.ts";

const assistant = (error?: string) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "working" }] },
    ...(error === undefined ? {} : { error }),
  }) as unknown as SDKMessage;
const maxTurns = {
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  errors: ["Reached maximum number of turns (2)"],
  session_id: "s-1",
} as unknown as SDKMessage;

const ask = (messages: SDKMessage[]) =>
  createClaudeDriver({
    query: fakeClaudeQuery(() => messages),
    openStepStream: () => undefined,
  }).ask?.(buildAskAgentRequest({ harness: harnesses.claude({ model: "haiku" }), prompt: "hi" }), {
    metadata: { workflowRunId: "wrun_errors" },
    deps: {} as never,
    env: {},
  });

test("an error result names the error of the last assistant message only", async () => {
  await expect(ask([assistant("rate_limit"), assistant(), maxTurns])).rejects.toThrow(
    /^Claude Code failed: Reached maximum number of turns \(2\)$/,
  );
  await expect(ask([assistant(), assistant("rate_limit"), maxTurns])).rejects.toThrow(
    "Claude Code failed (rate_limit): Reached maximum number of turns (2)",
  );
});
