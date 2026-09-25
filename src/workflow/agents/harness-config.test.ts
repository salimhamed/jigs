import { expect, test } from "vitest";
import type {
  AskableModelSource,
  ClaudeHarness,
  CodexHarness,
  ModelSource,
  PiHarness,
} from "./harness-config.ts";
import { claudePolicyKeys, codexPolicyKeys, harnesses, models } from "./harness-config.ts";
import { type AskJevOptions, yesNo } from "./jev.ts";
import type { AskAgentOptions, AskModelOptions, RunAgentOptions } from "./plan.ts";

test("descriptor namespaces build tagged plain data", () => {
  expect(harnesses.claude({ model: "sonnet", effort: "medium" })).toEqual({
    kind: "claude",
    model: "sonnet",
    effort: "medium",
  });
  expect(harnesses.codex({ model: "gpt-5.5", effort: "xhigh" })).toEqual({
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
  const model: AskModelOptions = { model: harnesses.claude({ model: "sonnet" }), prompt: "ask" };
  // @ts-expect-error the Codex subscription source is only meaningful inside the Pi harness
  const codex: AskModelOptions = { model: models.openaiCodex("gpt-5.5"), prompt: "ask" };
  const jev: AskJevOptions<{ match: ReturnType<typeof yesNo> }> = {
    // @ts-expect-error askJev accepts a model source, not a harness
    model: harnesses.claude({ model: "sonnet" }),
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

// Each entry is a compile error at the constructor: jigs sets it or holds it as policy.
const claudePolicyRejected = [
  // @ts-expect-error cwd is Claude policy
  () => harnesses.claude({ model: "opus", cwd: "/elsewhere" }),
  // @ts-expect-error env is Claude policy
  () => harnesses.claude({ model: "opus", env: {} }),
  // @ts-expect-error pathToClaudeCodeExecutable is Claude policy
  () => harnesses.claude({ model: "opus", pathToClaudeCodeExecutable: "/bin/claude" }),
  // @ts-expect-error executable is Claude policy
  () => harnesses.claude({ model: "opus", executable: "node" }),
  // @ts-expect-error executableArgs is Claude policy
  () => harnesses.claude({ model: "opus", executableArgs: [] }),
  // @ts-expect-error permissionMode is Claude policy
  () => harnesses.claude({ model: "opus", permissionMode: "default" }),
  // @ts-expect-error allowDangerouslySkipPermissions is Claude policy
  () => harnesses.claude({ model: "opus", allowDangerouslySkipPermissions: false }),
  // @ts-expect-error strictMcpConfig is Claude policy
  () => harnesses.claude({ model: "opus", strictMcpConfig: false }),
  // @ts-expect-error settingSources is Claude policy
  () => harnesses.claude({ model: "opus", settingSources: ["user"] }),
  // @ts-expect-error resume is Claude policy
  () => harnesses.claude({ model: "opus", resume: "s" }),
  // @ts-expect-error continue is Claude policy
  () => harnesses.claude({ model: "opus", continue: true }),
  // @ts-expect-error sessionId is Claude policy
  () => harnesses.claude({ model: "opus", sessionId: "s" }),
  // @ts-expect-error forkSession is Claude policy
  () => harnesses.claude({ model: "opus", forkSession: true }),
  // @ts-expect-error persistSession is Claude policy
  () => harnesses.claude({ model: "opus", persistSession: false }),
  // @ts-expect-error resumeSessionAt is Claude policy
  () => harnesses.claude({ model: "opus", resumeSessionAt: "m" }),
  // @ts-expect-error resumeDropsTurn is Claude policy
  () => harnesses.claude({ model: "opus", resumeDropsTurn: "m" }),
  // @ts-expect-error extraArgs is Claude policy
  () => harnesses.claude({ model: "opus", extraArgs: {} }),
  // @ts-expect-error sdkOptions is Claude policy
  () => harnesses.claude({ model: "opus", sdkOptions: {} }),
  // @ts-expect-error agents is Claude policy
  () => harnesses.claude({ model: "opus", agents: {} }),
  // @ts-expect-error settings is Claude policy
  () => harnesses.claude({ model: "opus", settings: "/etc/claude.json" }),
  // @ts-expect-error plugins is Claude policy
  () => harnesses.claude({ model: "opus", plugins: [] }),
  // @ts-expect-error mcpServers takes jigs' shape with a probe, not the provider's
  () => harnesses.claude({ model: "opus", mcpServers: { s: { type: "stdio", command: "x" } } }),
];
const codexPolicyRejected = [
  // @ts-expect-error cwd is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", cwd: "/elsewhere" }),
  // @ts-expect-error env is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", env: {} }),
  // @ts-expect-error codexPath is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", codexPath: "/bin/codex" }),
  // @ts-expect-error approvalPolicy is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", approvalPolicy: "on-request" }),
  // @ts-expect-error sandboxPolicy is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", sandboxPolicy: "read-only" }),
  // @ts-expect-error autoApprove is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", autoApprove: false }),
  // @ts-expect-error threadMode is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", threadMode: "stateless" }),
  // @ts-expect-error resume is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", resume: "t" }),
  // @ts-expect-error persistExtendedHistory is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", persistExtendedHistory: true }),
  // @ts-expect-error configOverrides is Codex policy
  () => harnesses.codex({ model: "gpt-5.5", configOverrides: {} }),
  // @ts-expect-error mcpServers takes jigs' shape with a probe, not the provider's
  () => harnesses.codex({ model: "gpt-5.5", mcpServers: { s: { transport: "stdio" } } }),
];
// Functions cannot cross into a step, so no callback is a descriptor key.
const functionsRejected = [
  // @ts-expect-error a callback is not data
  () => harnesses.claude({ model: "opus", stderr: () => {} }),
  // @ts-expect-error a hook is a function, however deep it sits
  () => harnesses.claude({ model: "opus", hooks: { PreToolUse: [{ hooks: [async () => ({})] }] } }),
  // @ts-expect-error a logger is an object of functions
  () => harnesses.claude({ model: "opus", logger: false }),
  // @ts-expect-error a tool-approval callback is not data
  () => harnesses.claude({ model: "opus", canUseTool: async () => ({ behavior: "allow" }) }),
  // @ts-expect-error a callback is not data
  () => harnesses.codex({ model: "gpt-5.5", onSessionCreated: () => {} }),
  // @ts-expect-error a logger is an object of functions
  () => harnesses.codex({ model: "gpt-5.5", logger: false }),
];

test("a descriptor holds only the provider's data settings outside the policy lists", () => {
  const claude: ClaudeHarness = harnesses.claude({
    model: "opus",
    effort: "high",
    maxTurns: 40,
    allowedTools: ["Read", "Edit"],
    maxBudgetUsd: 5,
    fallbackModel: "sonnet",
  });
  expect(claude).toEqual({
    kind: "claude",
    model: "opus",
    effort: "high",
    maxTurns: 40,
    allowedTools: ["Read", "Edit"],
    maxBudgetUsd: 5,
    fallbackModel: "sonnet",
  });
  const codex: CodexHarness = harnesses.codex({
    model: "gpt-5.6-sol",
    personality: "pragmatic",
    developerInstructions: "Prefer small commits.",
  });
  expect(codex).toEqual({
    kind: "codex",
    model: "gpt-5.6-sol",
    personality: "pragmatic",
    developerInstructions: "Prefer small commits.",
  });
  // Rejected at compile time, so the list only has to exist.
  expect(claudePolicyRejected).toHaveLength(claudePolicyKeys.length);
  expect(codexPolicyRejected).toHaveLength(codexPolicyKeys.length);
  expect(functionsRejected).toHaveLength(6);
});

test("a settings object held in a variable is checked too", () => {
  const settings = { model: "opus", permissionMode: "default" as const };
  // @ts-expect-error permissionMode is Claude policy
  const harness = () => harnesses.claude(settings);
  expect(harness).toBeTypeOf("function");
});
