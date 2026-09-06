import { expect, test } from "vitest";
import { claude, codex } from "./config.ts";

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
