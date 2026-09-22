import { expect, test } from "vitest";
import { z } from "zod";
import { harnesses, models } from "./harness-config.ts";
import { buildAgentRequest, buildAskAgentRequest, buildModelRequest, parseOutput } from "./plan.ts";

const verdict = z.object({ approved: z.boolean(), note: z.string() });

test("builders convert schemas and preserve serializable descriptors", () => {
  const run = buildAgentRequest({
    harness: harnesses.claude("sonnet"),
    cwd: "/work/tree",
    prompt: "review",
    output: verdict,
  });
  expect(run.outputSchema).toMatchObject({ type: "object", required: ["approved", "note"] });
  expect(run.outputSchema?.$schema).toBeUndefined();
  const ask = buildAskAgentRequest({
    harness: harnesses.codex("gpt-5.5"),
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
      harness: harnesses.claude("sonnet", {
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
        mcpServers: {
          probe: { command: "node", tools: ["ping"], probe: { tool: "ping" } },
        },
      },
      prompt: "ask",
    }),
  ).toThrow(/no MCP universe/);
});

test("parseOutput validates structured output", () => {
  expect(parseOutput(undefined, { anything: true })).toBeUndefined();
  expect(parseOutput(verdict, { approved: true, note: "ship" })).toEqual({
    approved: true,
    note: "ship",
  });
  expect(() => parseOutput(verdict, { approved: "yes" })).toThrow();
});
