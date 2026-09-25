import { expect, test, vi } from "vitest";
import { z } from "zod";
import { type AgentSteps, bindAgentSteps } from "./bind.ts";
import { models } from "./harness-config.ts";
import { type ExecuteJevStep, yesNo } from "./jev.ts";

const unused = async (): Promise<never> => {
  throw new Error("unexpected step");
};

test("a factory can override a named step and retain typed output parsing", async () => {
  const executeModel = vi.fn<AgentSteps["executeModel"]>(async () => ({
    text: "",
    output: { count: 3 },
  }));
  const bound = bindAgentSteps({ executeAgent: unused, executeModel, executeJev: unused });
  const result = await bound.askModel({
    model: models.openrouter("anthropic/claude-haiku"),
    prompt: "Count",
    output: z.object({ count: z.number() }),
  });
  expect(result.output.count).toBe(3);
  expect(executeModel).toHaveBeenCalledOnce();

  executeModel.mockResolvedValueOnce({ text: "", output: { count: "invalid" } });
  await expect(
    bound.askModel({
      model: models.openrouter("anthropic/claude-haiku"),
      prompt: "Count",
      output: z.object({ count: z.number() }),
    }),
  ).rejects.toThrow();
});

test("generic agents require no ticket or pull-request steps", async () => {
  const executeModel = vi.fn<AgentSteps["executeModel"]>(async function (this: unknown) {
    expect(this).toBeUndefined();
    return { text: "", output: { finding: "unused" } };
  });
  const bound = bindAgentSteps({ executeAgent: unused, executeModel, executeJev: unused });
  expect(
    await bound.askModel({
      model: models.openrouter("anthropic/claude-haiku"),
      prompt: "Summarize evidence",
      output: z.object({ finding: z.string() }),
    }),
  ).toMatchObject({ output: { finding: "unused" } });
  expect(executeModel).toHaveBeenCalledOnce();
});

test("a factory binding exposes typed decision questions", async () => {
  let calls = 0;
  const executeJev: ExecuteJevStep = async () => {
    calls += 1;
    throw new Error("decision step called");
  };
  const bound = bindAgentSteps({ executeAgent: unused, executeModel: unused, executeJev });

  await expect(
    bound.askJev({
      model: models.openrouter("typesafe/jev-1.13"),
      state: "CRM and billing records",
      questions: { match: yesNo("Do they identify the same company?") },
    }),
  ).rejects.toThrow("decision step called");
  expect(calls).toBe(1);
});
