import { expect, test } from "vitest";
import { claude, codex, StructuredOutputUnsupportedError } from "./config.ts";

test("claude() returns a tagged plain-data descriptor", () => {
  const descriptor = claude({
    model: "sonnet",
    mcpServers: { probe: { command: "node", args: ["probe.mjs"] } },
  });
  expect(descriptor).toEqual({
    kind: "claude",
    model: "sonnet",
    mcpServers: { probe: { command: "node", args: ["probe.mjs"] } },
  });
  expect(structuredClone(descriptor)).toEqual(descriptor);
});

test("codex() returns a tagged plain-data descriptor", () => {
  const descriptor = codex({
    model: "gpt-5.5",
    mcpServers: { linear: { url: "https://mcp.example", headers: { a: "b" } } },
  });
  expect(descriptor).toEqual({
    kind: "codex",
    model: "gpt-5.5",
    mcpServers: { linear: { url: "https://mcp.example", headers: { a: "b" } } },
  });
  expect(structuredClone(descriptor)).toEqual(descriptor);
});

test("StructuredOutputUnsupportedError names the offending kind", () => {
  const error = new StructuredOutputUnsupportedError("pi");
  expect(error.name).toBe("StructuredOutputUnsupportedError");
  expect(error.message).toContain("'pi'");
});
