import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { checkWorktreeCodexMcpConfig } from "./codex-config-guard.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

function writeConfig(content: string): void {
  mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  writeFileSync(path.join(tmp, ".codex", "config.toml"), content);
}

test("no .codex/config.toml passes", () => {
  expect(checkWorktreeCodexMcpConfig(tmp)).toEqual({ ok: true });
});

test("an empty or trust-record-only config passes", () => {
  writeConfig("");
  expect(checkWorktreeCodexMcpConfig(tmp).ok).toBe(true);
  writeConfig('[projects."/some/worktree"]\ntrust_level = "trusted"\n');
  expect(checkWorktreeCodexMcpConfig(tmp).ok).toBe(true);
});

test("a table-form mcp_servers declaration fails naming the server", () => {
  writeConfig('[mcp_servers.sneaky]\ncommand = "node"\nargs = ["evil.js"]\n');
  const result = checkWorktreeCodexMcpConfig(tmp);
  expect(result.ok).toBe(false);
  expect(result).toMatchObject({
    reason: expect.stringContaining("sneaky"),
    repair: expect.stringContaining("sneaky"),
  });
});

test("an inline-table mcp_servers declaration fails", () => {
  writeConfig('mcp_servers = { sneaky = { command = "node" } }\n');
  expect(checkWorktreeCodexMcpConfig(tmp)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("sneaky"),
  });
});

test("multiple servers are all named, sorted", () => {
  writeConfig(
    '[mcp_servers.zeta]\ncommand = "z"\n[mcp_servers.alpha]\ncommand = "a"\n',
  );
  expect(checkWorktreeCodexMcpConfig(tmp)).toMatchObject({
    reason: expect.stringContaining("alpha, zeta"),
  });
});

test("sub-tables under a server still name the server", () => {
  writeConfig('[mcp_servers.sneaky.env]\nTOKEN = "x"\n');
  expect(checkWorktreeCodexMcpConfig(tmp)).toMatchObject({
    reason: expect.stringContaining("sneaky"),
  });
});

test("an empty mcp_servers table passes", () => {
  writeConfig("[mcp_servers]\n");
  expect(checkWorktreeCodexMcpConfig(tmp).ok).toBe(true);
});

test("unparseable TOML fails closed", () => {
  writeConfig("this is [not toml");
  expect(checkWorktreeCodexMcpConfig(tmp)).toMatchObject({
    ok: false,
    reason: expect.stringContaining("could not be parsed"),
  });
});
