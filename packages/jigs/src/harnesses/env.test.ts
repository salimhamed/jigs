import { expect, test } from "vitest";
import { stripApiCredentials } from "./env.ts";

const dirty = () => ({
  ANTHROPIC_API_KEY: "sk-ant",
  ANTHROPIC_BASE_URL: "https://x",
  AI_GATEWAY_API_KEY: "gw",
  OPENAI_API_KEY: "sk-oai",
  CLAUDECODE: "1",
  CLAUDE_PID: "123",
  CLAUDE_EFFORT: "high",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  PATH: "/usr/bin",
  HOME: "/home/tester",
});

test("stripApiCredentials removes every credential var and reports them", () => {
  const env = dirty();
  const stripped = stripApiCredentials(env);
  expect(stripped.sort()).toEqual([
    "AI_GATEWAY_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "OPENAI_API_KEY",
  ]);
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/tester" });
});
