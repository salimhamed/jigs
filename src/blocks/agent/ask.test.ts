import { expect, test } from "vitest";
import { askModel } from "./ask.ts";
import { claude } from "./harness-config.ts";

const refuse = (): never => {
  throw new Error("the step was called");
};

test("askModel() rejects a harness descriptor carrying mcpServers before any step call", async () => {
  await expect(
    askModel(
      {
        harness: claude({
          model: "sonnet",
          mcpServers: { probe: { command: "node", probe: { tool: "ping" } } },
        }),
        prompt: "never runs",
      },
      refuse,
    ),
  ).rejects.toThrow(/no MCP universe/);
});
