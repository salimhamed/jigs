import { expect, test } from "vitest";
import { z } from "zod";
import {
  agent,
  ask,
  buildAgentWire,
  claude,
  JitCheckError,
  parseOutput,
  type RunAgentStep,
  unwrapAgentStep,
} from "./index.ts";
import { runAgent } from "./run.ts";

// Stands in for a factory's wrapper, minus the directive: it delegates to
// runAgent the way a factory's own does.
const runStep: RunAgentStep = (wire) => runAgent(wire, "run-under-test");

const refuse = (): never => {
  throw new Error("the step was called");
};

test("parseOutput returns undefined when no output schema is declared", () => {
  expect(parseOutput(undefined, { anything: true })).toBeUndefined();
});

test("parseOutput returns the typed parsed object for conforming recorded raw output", () => {
  const verdict = z.object({ approved: z.boolean(), note: z.string() });
  expect(parseOutput(verdict, { approved: true, note: "ship it" })).toEqual({
    approved: true,
    note: "ship it",
  });
});

test("parseOutput throws for non-conforming recorded raw output", () => {
  const verdict = z.object({ approved: z.boolean(), note: z.string() });
  expect(() => parseOutput(verdict, { approved: "yes" })).toThrow();
});

test("ask() rejects a harness descriptor carrying mcpServers before any step call", async () => {
  await expect(
    ask(
      {
        harness: claude({
          model: "sonnet",
          mcpServers: { probe: { command: "node", probe: { tool: "ping" } } },
        }),
        prompt: "never runs",
      },
      refuse,
    ),
  ).rejects.toThrow(/no MCP universe/);
});

test("an agent step whose declared MCP server cannot start returns the JIT failure instead of throwing", async () => {
  const wire = buildAgentWire({
    harness: claude({
      model: "sonnet",
      mcpServers: {
        linear: {
          command: "definitely-not-a-binary",
          probe: { tool: "get_probe_token" },
        },
      },
    }),
    cwd: "/work/tree",
    prompt: "never reached — the JIT check fails first",
  });

  const result = await runStep(wire);

  expect(result).toMatchObject({
    jitFailure: expect.stringContaining("MCP server linear"),
  });
  expect(result).toMatchObject({
    jitFailure: expect.stringContaining("→ fix the 'linear' server"),
  });
});

test("the resumeFailed marker becomes a throw carrying the provider's own words", () => {
  const detail = "no rollout found for thread id 0199-gone";
  expect(() => unwrapAgentStep({ resumeFailed: detail })).toThrow(detail);
});

test("a step result carrying neither marker passes through untouched", () => {
  const result = { text: "done", output: undefined };
  expect(unwrapAgentStep(result)).toBe(result);
});

test("agent() turns a failed JIT check into a thrown JitCheckError carrying the repair text", async () => {
  const failing = agent(
    {
      harness: claude({
        model: "sonnet",
        mcpServers: {
          linear: {
            command: "definitely-not-a-binary",
            probe: { tool: "get_probe_token" },
          },
        },
      }),
      cwd: "/work/tree",
      prompt: "never reached — the JIT check fails first",
    },
    runStep,
  );
  await expect(failing).rejects.toThrow(JitCheckError);
  await expect(failing).rejects.toThrow(/MCP server linear/);
  await expect(failing).rejects.toThrow(/→ fix the 'linear' server/);
});
