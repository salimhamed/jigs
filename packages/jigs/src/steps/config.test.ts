import { expect, test } from "vitest";
import {
  claude,
  codex,
  STRUCTURED_OUTPUT_SUPPORT,
  StructuredOutputUnsupportedError,
} from "./config.ts";

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

test("the capability table covers every harness kind and both support structured output", () => {
  expect(STRUCTURED_OUTPUT_SUPPORT).toEqual({ claude: true, codex: true });
});

test("StructuredOutputUnsupportedError names the offending kind", () => {
  const error = new StructuredOutputUnsupportedError("pi");
  expect(error.name).toBe("StructuredOutputUnsupportedError");
  expect(error.message).toContain("'pi'");
});
