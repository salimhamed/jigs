import { expect, test } from "vitest";
import { z } from "zod";
import { askAgent } from "./ask-agent.ts";
import { askModel } from "./ask-model.ts";
import { harnesses, models } from "./harness-config.ts";

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

test("an invalid askModel answer is asked for once more with the original prompt and the reasons", async () => {
  const prompts: string[] = [];
  const answers = [{ label: 3 }, { label: "bug" }];
  const result = await askModel(
    {
      model: models.openrouter("openai/gpt-5"),
      prompt: "Classify it.",
      output: z.strictObject({ label: z.string() }),
    },
    async (wire) => {
      prompts.push(wire.prompt);
      return { text: "", output: answers[prompts.length - 1] };
    },
  );

  expect(result.output).toEqual({ label: "bug" });
  expect(prompts[1]).toMatch(/^Classify it\.\n\nYour answer was rejected:\n.*label/s);
});
