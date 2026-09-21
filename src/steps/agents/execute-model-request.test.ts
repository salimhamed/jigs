import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { askModel } from "../../blocks/agents/ask-model.ts";
import { harnesses, models } from "../../blocks/agents/harness-config.ts";
import { askJev, choice, type JevQuestions, score, yesNo } from "../../blocks/agents/jev.ts";
import { buildAskAgentRequest, buildModelRequest } from "../../blocks/agents/plan.ts";
import { drivers } from "./drivers/index.ts";
import { defaultAgentExecutionDependencies } from "./execute-agent.ts";
import { executeJev, executeModel } from "./execute-model-request.ts";

const openaiCompatible = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@ai-sdk/openai-compatible", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/openai-compatible")>();
  openaiCompatible.create.mockImplementation(actual.createOpenAICompatible);
  return { ...actual, createOpenAICompatible: openaiCompatible.create };
});

const boundaries = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  mkdtempSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: boundaries.execFile,
  spawn: boundaries.spawn,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdtempSync: boundaries.mkdtempSync,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const verdict = z.object({ ok: z.boolean() });

test("askJev rejects a non-decision model by name", async () => {
  await expect(
    askJev(
      {
        model: models.openrouter("anthropic/claude-haiku"),
        state: "evidence",
        questions: { match: yesNo("Does it match?") },
      },
      (wire) => executeJev(wire, { workflowRunId: "run-1" }),
    ),
  ).rejects.toThrow(
    "anthropic/claude-haiku is not a jev-class model; askJev accepts only jev-class models",
  );
});

test("askJev rejects a model kind whose driver has no decision capability", async () => {
  await expect(
    executeJev(
      {
        model: models.openaiCompatible({
          name: "local",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "local-chat",
        }),
        state: "evidence",
        questions: { match: yesNo("Does it match?") },
      },
      { workflowRunId: "run-1" },
    ),
  ).rejects.toThrow("local-chat cannot be used with askJev");
});

test("askJev rejects cyclic state before calling the provider", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  type CyclicState = { account: string; self?: CyclicState };
  const state: CyclicState = { account: "Acme" };
  state.self = state;
  const evaluate = vi.fn();
  await expect(
    executeJev(
      {
        model: models.openrouter("typesafe/jev-1.13"),
        state,
        questions: { match: yesNo("Does it match?") },
      },
      { workflowRunId: "run-1" },
      { ...defaultAgentExecutionDependencies, evaluate },
    ),
  ).rejects.toThrow("state must be JSON-compatible");
  expect(evaluate).not.toHaveBeenCalled();
});

test("OpenRouter evaluates typed questions and normalizes metadata and cost", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  const evaluate = vi.fn(async () => ({
    answers: {
      sameCompany: { type: "boolean" as const, probability: 0.96 },
      disposition: {
        type: "choice" as const,
        choice: "match",
        probabilities: { match: 0.9, review: 0.1 },
      },
      similarity: {
        type: "score" as const,
        score: 1.72,
        probabilities: { "0": 0.03, "1": 0.22, "2": 0.75 },
      },
    },
    usage: { inputTokens: 48, outputTokens: 5, totalTokens: 53 },
    providerMetadata: {
      openrouter: {
        answers: {
          disposition: { confidence: 0.81 },
          similarity: {
            confidence: 0.88,
            legend: { "0": "Different", "1": "Possible", "2": "Same" },
          },
        },
        usage: { cost: 0.000002016 },
      },
    },
  }));
  const result = await askJev(
    {
      model: models.openrouter("typesafe/jev-1.13"),
      state: { crm: { name: "Acme" }, billing: { name: "ACME Inc." } },
      questions: {
        sameCompany: yesNo("Same company?"),
        disposition: choice("What next?", { match: "Link", review: "Review" }),
        similarity: score("Similarity?", ["Different", "Possible", "Same"]),
      },
    },
    (wire) =>
      executeJev(
        wire,
        { workflowRunId: "run-1" },
        {
          ...defaultAgentExecutionDependencies,
          evaluate,
        },
      ),
  );

  expect(evaluate).toHaveBeenCalledWith(
    expect.objectContaining({
      model: expect.objectContaining({ modelId: "typesafe/jev-1.13" }),
      state: { crm: { name: "Acme" }, billing: { name: "ACME Inc." } },
      questions: {
        sameCompany: { type: "boolean", instructions: "Same company?" },
        disposition: {
          type: "choice",
          instructions: "What next?",
          criteria: { match: "Link", review: "Review" },
        },
        similarity: {
          type: "score",
          instructions: "Similarity?",
          criteria: ["Different", "Possible", "Same"],
        },
      },
    }),
  );
  expect(result).toEqual({
    answers: {
      sameCompany: { probability: 0.96 },
      disposition: {
        choice: "match",
        probabilities: { match: 0.9, review: 0.1 },
        confidence: 0.81,
      },
      similarity: {
        score: 1.72,
        probabilities: { "0": 0.03, "1": 0.22, "2": 0.75 },
        confidence: 0.88,
        legend: { "0": "Different", "1": "Possible", "2": "Same" },
      },
    },
    usage: { inputTokens: 48, outputTokens: 5, totalTokens: 53, costUsd: 0.000002016 },
  });
});

test("a malformed question raises a JigsError naming its key before the provider call", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  const evaluate = vi.fn(async () => {
    throw new Error("provider must not run");
  });
  await expect(
    executeJev(
      {
        model: models.openrouter("typesafe/jev-1.13"),
        state: "evidence",
        questions: {
          accountRisk: {
            type: "score",
            instructions: "How risky is this account?",
            levels: null as unknown as string[],
          },
        },
      },
      { workflowRunId: "run-1" },
      { ...defaultAgentExecutionDependencies, evaluate },
    ),
  ).rejects.toThrow('question "accountRisk" is malformed');
  expect(evaluate).not.toHaveBeenCalled();
});

test("a provider argument error is translated to the offending question key", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  const providerError = new Error(
    "Invalid argument for questions.disposition.criteria: descriptions are incomplete",
  );
  providerError.name = "AI_InvalidArgumentError";
  await expect(
    executeJev(
      {
        model: models.openrouter("typesafe/jev-1.13"),
        state: "evidence",
        questions: {
          disposition: choice("What next?", { match: "Link", review: "Review" }),
        },
      },
      { workflowRunId: "run-1" },
      {
        ...defaultAgentExecutionDependencies,
        evaluate: async () => {
          throw providerError;
        },
      },
    ),
  ).rejects.toThrow('question "disposition" is malformed');
});

const malformedProviderCases: Array<{
  label: string;
  questions: JevQuestions;
  answers: Record<string, unknown>;
  metadata: Record<string, unknown>;
  key: string;
}> = [
  {
    label: "missing answer",
    questions: { match: yesNo("Match?") },
    answers: {},
    metadata: {},
    key: "match",
  },
  {
    label: "missing choice confidence",
    questions: { disposition: choice("What next?", { match: "Link", review: "Review" }) },
    answers: {
      disposition: {
        type: "choice",
        choice: "match",
        probabilities: { match: 0.8, review: 0.2 },
      },
    },
    metadata: { disposition: {} },
    key: "disposition",
  },
  {
    label: "incomplete score legend",
    questions: { similarity: score("Similarity?", ["Different", "Same"]) },
    answers: {
      similarity: { type: "score", score: 0.7, probabilities: { "0": 0.3, "1": 0.7 } },
    },
    metadata: { similarity: { confidence: 0.9, legend: { "0": "Different" } } },
    key: "similarity",
  },
];

test.each(malformedProviderCases)(
  "a $label from the provider becomes a keyed JigsError",
  async ({ questions, answers, metadata, key }) => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    await expect(
      executeJev(
        {
          model: models.openrouter("typesafe/jev-1.13"),
          state: "evidence",
          questions,
        },
        { workflowRunId: "run-1" },
        {
          ...defaultAgentExecutionDependencies,
          evaluate: async () => ({
            answers,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: { openrouter: { answers: metadata } },
          }),
        },
      ),
    ).rejects.toThrow(`question "${key}" is malformed`);
  },
);

test("the OpenRouter driver accepts only OpenRouter model descriptors", async () => {
  const context = {
    metadata: { workflowRunId: "run-1" },
    deps: defaultAgentExecutionDependencies,
    env: {},
  };

  await expect(
    drivers.openrouter.ask(
      buildAskAgentRequest({ harness: harnesses.claude("sonnet"), prompt: "wrong family" }),
      context,
    ),
  ).rejects.toThrow("the OpenRouter driver requires an OpenRouter model request");
  await expect(
    drivers.openrouter.ask(
      buildModelRequest({
        model: models.openaiCompatible({
          name: "local",
          baseUrl: "http://localhost:1234/v1",
          model: "local",
        }),
        prompt: "wrong model source",
      }),
      context,
    ),
  ).rejects.toThrow("the OpenRouter driver requires an OpenRouter model request");
});

test("an OpenAI-compatible source answers structured requests without requiring a key", async () => {
  const requests: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ input, init });
    if (String(input).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "served-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "generation-1",
        object: "chat.completion",
        created: 1,
        model: "served-model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: '{"ok":true}' },
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await askModel(
    {
      model: models.openaiCompatible({
        name: "north-desktop",
        baseUrl: "http://localhost:1234/v1",
        model: "served-model",
        compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
      }),
      prompt: "Return ok true.",
      output: verdict,
    },
    (wire) =>
      executeModel(
        wire,
        { workflowRunId: "run-1" },
        {
          ...defaultAgentExecutionDependencies,
          generateText: (options) => import("ai").then(({ generateText }) => generateText(options)),
        },
      ),
  );

  expect(result.output).toEqual({ ok: true });
  expect(result.usage?.costUsd).toBeUndefined();
  expect(openaiCompatible.create).toHaveBeenCalledWith({
    baseURL: "http://localhost:1234/v1",
    name: "north-desktop",
    supportsStructuredOutputs: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
  });
  expect(requests).toHaveLength(2);
  const request = requests[1];
  expect(String(request?.input)).toBe("http://localhost:1234/v1/chat/completions");
  expect(new Headers(request?.init?.headers).has("authorization")).toBe(false);
  expect(JSON.parse(String(request?.init?.body))).toMatchObject({
    model: "served-model",
    response_format: { type: "json_schema", json_schema: { strict: true } },
  });
});

test("an OpenAI-compatible source uses only its optional named credential", async () => {
  vi.stubEnv("LOCAL_MODEL_KEY", "test-key");
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    if (String(input).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "served-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id: "generation-1",
        object: "chat.completion",
        created: 1,
        model: "served-model",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const source = models.openaiCompatible({
    name: "secured-server",
    baseUrl: "https://models.example/v1",
    model: "served-model",
    apiKeyEnv: "LOCAL_MODEL_KEY",
  });

  await expect(
    executeModel(buildModelRequest({ model: source, prompt: "answer" }), {
      workflowRunId: "run-1",
    }),
  ).resolves.toMatchObject({ text: "ok" });
  expect(
    drivers["openai-compatible"].envAllowlist(buildModelRequest({ model: source, prompt: "x" })),
  ).toEqual(["LOCAL_MODEL_KEY"]);
  expect(
    drivers["openai-compatible"]
      .authChecks(buildModelRequest({ model: source, prompt: "x" }))
      .map((check) => check.id),
  ).toEqual(["model.local-model-key"]);
  const withoutKey = buildModelRequest({
    model: models.openaiCompatible({
      name: "open-server",
      baseUrl: "https://models.example/v1",
      model: "served-model",
    }),
    prompt: "x",
  });
  expect(drivers["openai-compatible"].envAllowlist(withoutKey)).toEqual([]);
  expect(drivers["openai-compatible"].authChecks(withoutKey)).toEqual([]);
});

test("OpenRouter answers one structured request directly and reports its cost", async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  const requests: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(
      JSON.stringify({
        id: "generation-1",
        object: "chat.completion",
        created: 1,
        model: "google/gemini-2.5-flash-lite",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: '{"ok":true}' },
          },
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 4,
          total_tokens: 11,
          cost: 0.0000055,
          cost_details: { upstream_inference_cost: 0.000004 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const result = await askModel(
    {
      model: models.openrouter("google/gemini-2.5-flash-lite", {
        apiKeyEnv: "OPENAI_API_KEY",
      }),
      prompt: "Return ok true.",
      output: verdict,
    },
    (wire) =>
      executeModel(
        wire,
        { workflowRunId: "run-1" },
        {
          ...defaultAgentExecutionDependencies,
          generateText: (options) => import("ai").then(({ generateText }) => generateText(options)),
        },
      ),
  );

  expect(result.output).toEqual({ ok: true });
  expect(result.usage?.costUsd).toBe(0.0000055);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  const headers = new Headers(request?.init?.headers);
  expect(headers.get("authorization")).toBe("Bearer test-key");
  expect(headers.get("HTTP-Referer")).toBe("https://github.com/salimhamed/jigs");
  expect(headers.get("X-Title")).toBe("jigs");
  const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({
    model: "google/gemini-2.5-flash-lite",
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { strict: true } },
  });
  expect(boundaries.execFile).not.toHaveBeenCalled();
  expect(boundaries.spawn).not.toHaveBeenCalled();
  expect(boundaries.mkdtempSync).not.toHaveBeenCalled();
});

test("OpenRouter names the missing descriptor credential and its repair", async () => {
  vi.stubEnv("TEAM_OPENROUTER_KEY", "");

  await expect(
    executeModel(
      buildModelRequest({
        model: models.openrouter("google/gemini-2.5-flash-lite", {
          apiKeyEnv: "TEAM_OPENROUTER_KEY",
        }),
        prompt: "Return ok true.",
        output: verdict,
      }),
      { workflowRunId: "run-1" },
    ),
  ).rejects.toMatchObject({
    name: "JigsError",
    message: "TEAM_OPENROUTER_KEY is not set in the service's environment",
    hint: expect.stringContaining("set TEAM_OPENROUTER_KEY in the factory repo's .env"),
  });
});
