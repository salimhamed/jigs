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
        // @ts-expect-error askAgent accepts only a harness without MCP servers
        harness: harnesses.claude({
          model: "sonnet",
          mcpServers: { probe: { command: "node", probe: { tool: "ping" } } },
        }),
        prompt: "never",
      },
      execute,
    ),
  ).rejects.toThrow(/no MCP universe/);
});
