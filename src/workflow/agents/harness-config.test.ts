import { expect, test } from "vitest";
import type { AskableModelSource, ModelSource, PiHarness } from "./harness-config.ts";
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
  });
  const local = models.openaiCompatible({
    name: "secured-server",
    baseUrl: "https://models.example/v1",
    model: "served-model",
    apiKeyEnv: "LOCAL_MODEL_KEY",
  });
  expect(
    harnesses.pi(local, {
      compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
    }),
  ).toEqual({
    kind: "pi",
    model: local,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
  });
  expect(harnesses.pi(local)).toEqual({
    kind: "pi",
    model: local,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  });
});

test("harnesses.pi accepts a model source chosen at runtime", () => {
  const sources: ModelSource[] = [
    models.openaiCompatible({ name: "local", baseUrl: "http://localhost:1234/v1", model: "local" }),
    models.openrouter("model"),
  ];
  const [local, remote] = sources as [ModelSource, ModelSource];
  const askable: AskableModelSource = models.openrouter("model");
  const harness: PiHarness = harnesses.pi(local, { compat: { supportsReasoningEffort: true } });
  expect(harness).toEqual({
    kind: "pi",
    model: local,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  });
  expect(harnesses.pi(askable, { thinking: "low" })).toEqual({
    kind: "pi",
    model: askable,
    thinking: "low",
  });
  expect(() => harnesses.pi(remote, { compat: { supportsDeveloperRole: true } })).toThrow(
    "Pi compatibility hints apply only to OpenAI-compatible model sources",
  );
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
  const localJev: AskJevOptions<{ match: ReturnType<typeof yesNo> }> = {
    // @ts-expect-error askJev is statically limited to OpenRouter decision sources
    model: models.openaiCompatible({
      name: "local",
      baseUrl: "http://localhost:1234/v1",
      model: "local",
    }),
    state: "records",
    questions: { match: yesNo("Same?") },
  };
  const inertModelOption = models.openaiCompatible({
    name: "local",
    baseUrl: "http://localhost:1234/v1",
    model: "local",
    // @ts-expect-error Pi compatibility belongs to harnesses.pi, never askModel model sources
    pi: { supportsReasoningEffort: true },
  });
  const inertHarnessOption: PiHarness = {
    kind: "pi",
    model: models.openrouter("model"),
    // @ts-expect-error compatibility hints apply only to Pi's OpenAI-compatible source
    compat: { supportsReasoningEffort: true },
  };
  const inertPiCompat = () =>
    // @ts-expect-error compatibility hints apply only to Pi's OpenAI-compatible source
    harnesses.pi(models.openrouter("model"), { compat: { supportsReasoningEffort: true } });
  expect([
    run,
    agent,
    model,
    codex,
    jev,
    localJev,
    inertModelOption,
    inertHarnessOption,
    inertPiCompat,
  ]).toHaveLength(9);
});
