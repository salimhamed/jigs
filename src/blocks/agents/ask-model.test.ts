import { expect, test } from "vitest";
import { askAgent } from "./ask-agent.ts";
import { harnesses } from "./harness-config.ts";

test("askAgent rejects MCP servers before calling its step", async () => {
  const execute = async (): Promise<never> => {
    throw new Error("step called");
  };
  await expect(
    askAgent(
      {
        harness: harnesses.claude("sonnet", {
          mcpServers: { probe: { command: "node", probe: { tool: "ping" } } },
        }),
        prompt: "never",
      },
      execute,
    ),
  ).rejects.toThrow(/no MCP universe/);
});
