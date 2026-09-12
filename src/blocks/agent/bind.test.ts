import { expect, test, vi } from "vitest";
import { z } from "zod";
import { type AgentSteps, bindAgentSteps } from "./bind.ts";
import { claude } from "./harness-config.ts";

const unused = async (): Promise<never> => {
  throw new Error("unexpected step");
};

test("a factory can override a named step and retain typed output parsing", async () => {
  const executeModelRequest = vi.fn<AgentSteps["executeModelRequest"]>(async () => ({
    text: "",
    output: { count: 3 },
  }));
  const bound = bindAgentSteps({ executeAgent: unused, executeModelRequest });
  const result = await bound.askModel({
    harness: claude({ model: "sonnet" }),
    prompt: "Count",
    output: z.object({ count: z.number() }),
  });
  expect(result.output.count).toBe(3);
  expect(executeModelRequest).toHaveBeenCalledOnce();

  executeModelRequest.mockResolvedValueOnce({ text: "", output: { count: "invalid" } });
  await expect(
    bound.askModel({
      harness: claude({ model: "sonnet" }),
      prompt: "Count",
      output: z.object({ count: z.number() }),
    }),
  ).rejects.toThrow();
});

test("generic agents require no ticket or pull-request steps", async () => {
  const executeModelRequest = vi.fn<AgentSteps["executeModelRequest"]>(async function (
    this: unknown,
  ) {
    expect(this).toBeUndefined();
    return { text: "", output: { finding: "unused" } };
  });
  const bound = bindAgentSteps({ executeAgent: unused, executeModelRequest });
  expect(
    await bound.askModel({
      harness: claude({ model: "sonnet" }),
      prompt: "Summarize evidence",
      output: z.object({ finding: z.string() }),
    }),
  ).toMatchObject({ output: { finding: "unused" } });
  expect(executeModelRequest).toHaveBeenCalledOnce();
});
