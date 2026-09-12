import { expect, test } from "vitest";
import { claude, codex, selectHarness } from "./harness-config.ts";

test("claude() returns a tagged plain-data descriptor", () => {
  const descriptor = claude({
    model: "sonnet",
    mcpServers: {
      probe: { command: "node", args: ["probe.mjs"], probe: { tool: "ping" } },
    },
  });
  expect(descriptor).toEqual({
    kind: "claude",
    model: "sonnet",
    mcpServers: {
      probe: { command: "node", args: ["probe.mjs"], probe: { tool: "ping" } },
    },
  });
  expect(structuredClone(descriptor)).toEqual(descriptor);
});

test("codex() returns a tagged plain-data descriptor", () => {
  const descriptor = codex({
    model: "gpt-5.5",
    mcpServers: {
      linear: {
        url: "https://mcp.example",
        headers: { a: "b" },
        probe: { tool: "ping" },
      },
    },
  });
  expect(descriptor).toEqual({
    kind: "codex",
    model: "gpt-5.5",
    mcpServers: {
      linear: {
        url: "https://mcp.example",
        headers: { a: "b" },
        probe: { tool: "ping" },
      },
    },
  });
  expect(structuredClone(descriptor)).toEqual(descriptor);
});

// The factory's map, standing in for the one the scaffold declares.
const defaultModels = { claude: "opus", codex: "gpt-5.6-sol" };

test("a harness chosen without a model takes that harness's own default", () => {
  expect(selectHarness("claude", defaultModels)).toEqual({ kind: "claude", model: "opus" });
  expect(selectHarness("codex", defaultModels)).toEqual({ kind: "codex", model: "gpt-5.6-sol" });
});

test("an explicitly supplied model always wins", () => {
  expect(selectHarness("claude", defaultModels, "sonnet")).toEqual({
    kind: "claude",
    model: "sonnet",
  });
  expect(selectHarness("codex", defaultModels, "gpt-5.5")).toEqual({
    kind: "codex",
    model: "gpt-5.5",
  });
});

test("implementation and review resolve independently, each from its own harness", () => {
  const inputs = { implementationHarness: "claude", reviewHarness: "codex" } as const;
  expect(selectHarness(inputs.implementationHarness, defaultModels)).toEqual({
    kind: "claude",
    model: "opus",
  });
  expect(selectHarness(inputs.reviewHarness, defaultModels)).toEqual({
    kind: "codex",
    model: "gpt-5.6-sol",
  });
  // Naming one side's model leaves the other side's default alone.
  expect(selectHarness(inputs.reviewHarness, defaultModels, "gpt-5.5")).toEqual({
    kind: "codex",
    model: "gpt-5.5",
  });
  expect(selectHarness(inputs.implementationHarness, defaultModels)).toEqual({
    kind: "claude",
    model: "opus",
  });
});
