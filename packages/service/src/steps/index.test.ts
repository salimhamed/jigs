import {
  buildAgentWire,
  claude,
  type HarnessConfig,
  StructuredOutputUnsupportedError,
} from "jigs/steps";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  agent,
  ask,
  fn,
  JitCheckError,
  parseOutput,
  ResumeFailedError,
  runAgentStep,
  unwrapAgentStep,
} from "./index";

// Module scope, like a real fn() step function — but without the directive:
// the nitro workflow scan bundles any directive-bearing file into the server,
// tests included, and outside a workflow the directive is a no-op anyway.
async function addAndTag(a: number, b: number) {
  return { sum: a + b, tag: "added" };
}

test("fn() wraps a module-scope step function's return in a uniform StepResult", async () => {
  const result = await fn(addAndTag, 2, 40);
  expect(result).toEqual({
    text: "",
    output: { sum: 42, tag: "added" },
    files: [],
    usage: undefined,
  });
});

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

test("agent() rejects a structured-output declaration the harness cannot honor before any step call", async () => {
  const incapable = { kind: "pi", model: "pi-1" } as unknown as HarnessConfig;
  await expect(
    agent({
      harness: incapable,
      cwd: "/nowhere",
      prompt: "never runs",
      output: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow(StructuredOutputUnsupportedError);
});

test("ask() rejects a harness descriptor carrying mcpServers before any step call", async () => {
  await expect(
    ask({
      harness: claude({
        model: "sonnet",
        mcpServers: { probe: { command: "node", probe: { tool: "ping" } } },
      }),
      prompt: "never runs",
    }),
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

  const result = await runAgentStep(wire);

  expect(result).toMatchObject({
    jitFailure: expect.stringContaining("MCP server linear"),
  });
  expect(result).toMatchObject({
    jitFailure: expect.stringContaining("→ fix the 'linear' server"),
  });
});

test("the resumeFailed marker becomes a ResumeFailedError carrying the provider's own words", () => {
  const detail = "no rollout found for thread id 0199-gone";
  expect(() => unwrapAgentStep({ resumeFailed: detail })).toThrow(
    ResumeFailedError,
  );
  expect(() => unwrapAgentStep({ resumeFailed: detail })).toThrow(detail);
});

test("a step result carrying neither marker passes through untouched", () => {
  const result = { text: "done", output: undefined, files: [] };
  expect(unwrapAgentStep(result)).toBe(result);
});

test("agent() turns a failed JIT check into a thrown JitCheckError carrying the repair text", async () => {
  const failing = agent({
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
  await expect(failing).rejects.toThrow(JitCheckError);
  await expect(failing).rejects.toThrow(/MCP server linear/);
  await expect(failing).rejects.toThrow(/→ fix the 'linear' server/);
});
