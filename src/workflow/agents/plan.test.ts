import { expect, test } from "vitest";
import { z } from "zod";
import { type AskableHarness, type Harness, harnesses, models } from "./harness-config.ts";
import { buildAgentRequest, buildAskAgentRequest, buildModelRequest, parseOutput } from "./plan.ts";

type PiHarnessOptions = NonNullable<Parameters<typeof harnesses.pi>[1]>;

const verdict = z.object({ approved: z.boolean(), note: z.string() });

test("builders convert schemas and preserve serializable descriptors", () => {
  const run = buildAgentRequest({
    harness: harnesses.claude({ model: "sonnet" }),
    cwd: "/work/tree",
    prompt: "review",
    output: verdict,
  });
  expect(run.outputSchema).toMatchObject({ type: "object", required: ["approved", "note"] });
  expect(run.outputSchema?.$schema).toBeUndefined();
  const ask = buildAskAgentRequest({
    harness: harnesses.pi(models.openaiCodex("gpt-5.5")),
    prompt: "summarize",
    output: verdict,
  });
  const model = buildModelRequest({
    model: models.openrouter("anthropic/claude-haiku"),
    prompt: "summarize",
    output: verdict,
  });
  expect(structuredClone([run, ask, model])).toEqual([run, ask, model]);
});

test("askAgent rejects an MCP universe", () => {
  expect(() =>
    buildAskAgentRequest({
      // @ts-expect-error askAgent accepts only a harness without MCP servers
      harness: harnesses.claude({
        model: "sonnet",
        mcpServers: {
          probe: { command: "node", probe: { tool: "ping" } },
        },
      }),
      prompt: "ask",
    }),
  ).toThrow(/no MCP universe/);

  expect(() =>
    buildAskAgentRequest({
      harness: {
        ...harnesses.pi(models.openaiCodex("gpt-5.5")),
        // @ts-expect-error askAgent accepts only a harness without MCP servers
        mcpServers: {
          probe: { command: "node", tools: ["ping"], probe: { tool: "ping" } },
        },
      },
      prompt: "ask",
    }),
  ).toThrow(/no MCP universe/);
});

test("askAgent rejects Codex and a Pi tool allowlist at compile time and at runtime", () => {
  expect(() =>
    buildAskAgentRequest({
      // @ts-expect-error Codex has no mode without tools
      harness: harnesses.codex({ model: "gpt-5.5" }),
      prompt: "ask",
    }),
  ).toThrow("askAgent() cannot use the Codex harness");
  expect(() =>
    buildAskAgentRequest({
      // @ts-expect-error askAgent accepts only a Pi harness without a tool allowlist
      harness: harnesses.pi(models.openaiCodex("gpt-5.5"), { tools: ["read"] }),
      prompt: "ask",
    }),
  ).toThrow("askAgent() runs without tools");
  const allowlisted: PiHarnessOptions = { tools: ["read"] };
  expect(() =>
    buildAskAgentRequest({
      // @ts-expect-error options typed with a possible allowlist are not tool-free
      harness: harnesses.pi(models.openaiCodex("gpt-5.5"), allowlisted),
      prompt: "ask",
    }),
  ).toThrow("askAgent() runs without tools");
});

test("harness constructors stay tool-free only when their options name no tools", () => {
  const claude: AskableHarness = harnesses.claude({ model: "sonnet", effort: "high" });
  const pi: AskableHarness = harnesses.pi(models.openaiCodex("gpt-5.5"), { thinking: "low" });
  const local: AskableHarness = harnesses.pi(
    models.openaiCompatible({ name: "local", baseUrl: "http://localhost:1234/v1", model: "m" }),
    { compat: { supportsDeveloperRole: true } },
  );
  const runOnly: Harness = harnesses.pi(models.openaiCodex("gpt-5.5"), { tools: ["read"] });
  expect([claude, pi, local, runOnly].map((harness) => harness.kind)).toEqual([
    "claude",
    "pi",
    "pi",
    "pi",
  ]);
});

test("parseOutput validates structured output", () => {
  expect(parseOutput(undefined, { anything: true })).toBeUndefined();
  expect(parseOutput(verdict, { approved: true, note: "ship" })).toEqual({
    approved: true,
    note: "ship",
  });
  expect(() => parseOutput(verdict, { approved: "yes" })).toThrow();
});
