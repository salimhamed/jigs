import { expect, test } from "vitest";
import { z } from "zod";
import {
  claude,
  codex,
  type HarnessConfig,
  StructuredOutputUnsupportedError,
} from "./config.ts";
import { buildAgentWire, buildAskWire } from "./plan.ts";

const verdict = z.object({
  approved: z.boolean(),
  note: z.string(),
});

test("buildAgentWire converts the zod output schema into a wire JSON schema", () => {
  const { wire } = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: "/work/tree",
    prompt: "review it",
    output: verdict,
  });
  expect(wire.outputSchema).toMatchObject({
    type: "object",
    properties: {
      approved: { type: "boolean" },
      note: { type: "string" },
    },
    required: ["approved", "note"],
  });
  // The Claude CLI rejects a schema carrying zod's $schema meta-declaration.
  expect(wire.outputSchema?.$schema).toBeUndefined();
});

test("parseOutput returns the typed object and rejects non-conforming output", () => {
  const { parseOutput } = buildAgentWire({
    harness: claude({ model: "sonnet" }),
    cwd: "/work/tree",
    prompt: "review it",
    output: verdict,
  });
  expect(parseOutput({ approved: true, note: "ship it" })).toEqual({
    approved: true,
    note: "ship it",
  });
  expect(() => parseOutput({ approved: "yes" })).toThrow();
});

test("without an output schema the wire omits it and parseOutput yields undefined", () => {
  const { wire, parseOutput } = buildAskWire({
    harness: codex({ model: "gpt-5.5" }),
    prompt: "what changed?",
  });
  expect(wire.outputSchema).toBeUndefined();
  expect(parseOutput("raw text ignored")).toBeUndefined();
});

test("declaring output on a harness without the capability throws before any step call", () => {
  const incapable = { kind: "pi", model: "pi-1" } as unknown as HarnessConfig;
  expect(() =>
    buildAgentWire({
      harness: incapable,
      cwd: "/work/tree",
      prompt: "review it",
      output: verdict,
    }),
  ).toThrow(StructuredOutputUnsupportedError);
  expect(() =>
    buildAskWire({ harness: incapable, prompt: "hm", output: verdict }),
  ).toThrow(StructuredOutputUnsupportedError);
});

test("ask() rejects a harness descriptor carrying mcpServers", () => {
  expect(() =>
    buildAskWire({
      harness: claude({
        model: "sonnet",
        mcpServers: { probe: { command: "node" } },
      }),
      prompt: "no universe for you",
    }),
  ).toThrow(/no MCP universe/);
});

test("every builder wire survives structuredClone — builders never inject live values", () => {
  const agentPlan = buildAgentWire({
    harness: codex({
      model: "gpt-5.5",
      mcpServers: { probe: { command: "node", env: { TOKEN: "t" } } },
    }),
    cwd: "/work/tree",
    prompt: "implement it",
    instructions: "follow the brief",
    permissionMode: "bypassPermissions",
    output: verdict,
  });
  expect(structuredClone(agentPlan.wire)).toEqual(agentPlan.wire);

  const askPlan = buildAskWire({
    harness: claude({ model: "sonnet" }),
    prompt: "summarize",
    system: "be terse",
    output: verdict,
  });
  expect(structuredClone(askPlan.wire)).toEqual(askPlan.wire);
});
