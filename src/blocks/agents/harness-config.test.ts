import { expect, test } from "vitest";
import { harnesses, models } from "./harness-config.ts";
import { type AskJevOptions, yesNo } from "./jev.ts";
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
  expect(
    harnesses.pi(models.openaiCodex("gpt-5.5"), {
      thinking: "medium",
      tools: ["read", "grep"],
    }),
  ).toEqual({
    kind: "pi",
    model: { kind: "openai-codex", model: "gpt-5.5" },
    thinking: "medium",
    tools: ["read", "grep"],
  });
  expect(harnesses.pi(models.openaiCodex("gpt-5.5"))).toEqual({
    kind: "pi",
    model: { kind: "openai-codex", model: "gpt-5.5" },
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
  expect(
    models.openaiCompatible({
      name: "north-desktop",
      baseUrl: "http://localhost:1234/v1",
      model: "local",
    }),
  ).toEqual({
    kind: "openai-compatible",
    name: "north-desktop",
    model: "local",
    baseUrl: "http://localhost:1234/v1",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  });
  expect(
    models.openaiCompatible({
      name: "secured-server",
      baseUrl: "https://models.example/v1",
      model: "served-model",
      apiKeyEnv: "LOCAL_MODEL_KEY",
      compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
    }),
  ).toEqual({
    kind: "openai-compatible",
    name: "secured-server",
    baseUrl: "https://models.example/v1",
    model: "served-model",
    apiKeyEnv: "LOCAL_MODEL_KEY",
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
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
  const jev: AskJevOptions<{ match: ReturnType<typeof yesNo> }> = {
    // @ts-expect-error askJev accepts a model source, not a harness
    model: harnesses.claude("sonnet"),
    state: "records",
    questions: { match: yesNo("Same?") },
  };
  expect([run, agent, model, codex, jev]).toHaveLength(5);
});
