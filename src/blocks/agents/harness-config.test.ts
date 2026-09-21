import { expect, test } from "vitest";
import { harnesses, models } from "./harness-config.ts";
import type { AskAgentOptions, AskModelOptions, RunAgentOptions } from "./plan.ts";

test("descriptor namespaces build tagged plain data", () => {
  expect(harnesses.claude("sonnet", { effort: "medium" })).toEqual({
    kind: "claude",
    model: "sonnet",
    effort: "medium",
  });
  expect(harnesses.codex("gpt-5.5", { effort: "xhigh" })).toEqual({
    kind: "codex",
    model: "gpt-5.5",
    effort: "xhigh",
  });
  expect(models.openrouter("anthropic/claude-haiku")).toEqual({
    kind: "openrouter",
    model: "anthropic/claude-haiku",
    apiKeyEnv: "OPENROUTER_API_KEY",
  });
  expect(models.openrouter("anthropic/claude-haiku", { apiKeyEnv: "TEAM_OPENROUTER_KEY" })).toEqual(
    {
      kind: "openrouter",
      model: "anthropic/claude-haiku",
      apiKeyEnv: "TEAM_OPENROUTER_KEY",
    },
  );
  expect(models.openaiCompatible("local", { baseUrl: "http://localhost:1234/v1" })).toEqual({
    kind: "openai-compatible",
    model: "local",
    baseUrl: "http://localhost:1234/v1",
  });
});

test("verbs reject the wrong descriptor family at compile time", () => {
  // @ts-expect-error runAgent accepts a harness, not a model source
  const run: RunAgentOptions = { harness: models.openrouter("model"), cwd: "/tmp", prompt: "work" };
  // @ts-expect-error askAgent accepts a harness, not a model source
  const agent: AskAgentOptions = { harness: models.openrouter("model"), prompt: "ask" };
  // @ts-expect-error askModel accepts a model source, not a harness
  const model: AskModelOptions = { model: harnesses.claude("sonnet"), prompt: "ask" };
  // @ts-expect-error the Codex subscription source is only meaningful inside the Pi harness
  const codex: AskModelOptions = { model: models.openaiCodex("gpt-5.5"), prompt: "ask" };
  expect([run, agent, model, codex]).toHaveLength(4);
});
