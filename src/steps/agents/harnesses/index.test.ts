import * as claudeProvider from "ai-sdk-provider-claude-code";
import * as codexProvider from "ai-sdk-provider-codex-cli";
import { expect, test } from "vitest";
import * as harnesses from "./index.ts";

test("claude re-exports are identity-equal to the provider's", () => {
  expect(harnesses.claudeCode).toBe(claudeProvider.claudeCode);
  expect(harnesses.createClaudeCode).toBe(claudeProvider.createClaudeCode);
});

test("codex re-exports are identity-equal to the provider's", () => {
  expect(harnesses.codexExec).toBe(codexProvider.codexExec);
  expect(harnesses.createCodexExec).toBe(codexProvider.createCodexExec);
  expect(harnesses.codexAppServer).toBe(codexProvider.codexAppServer);
  expect(harnesses.createCodexAppServer).toBe(codexProvider.createCodexAppServer);
});
