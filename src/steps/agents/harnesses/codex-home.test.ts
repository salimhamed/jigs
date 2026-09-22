import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CURATED_CONFIG_TOML,
  codexAuthLink,
  codexSessionFile,
  managedCodexHomePath,
  prepareManagedCodexHome,
  removeManagedCodexHome,
} from "./codex-home.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
let realAuthPath: string;
let options: { baseDir: string; realAuthPath: string };

beforeEach(() => {
  tmp = makeTmpDir();
  realAuthPath = path.join(tmp, "real-codex", "auth.json");
  mkdirSync(path.dirname(realAuthPath), { recursive: true });
  writeFileSync(realAuthPath, '{"auth_mode":"chatgpt"}');
  options = { baseDir: path.join(tmp, "codex-homes"), realAuthPath };
});
afterEach(() => {
  removeTmpDir(tmp);
});

function rollout(sessionDir: string, threadId: string): string {
  const directory = path.join(sessionDir, "2026", "09", "21");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-21T00-00-00-${threadId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id: threadId } })}\n`);
  return file;
}

test("parallel Codex invocations have private config and one durable rollout store", () => {
  const first = prepareManagedCodexHome("run-1", options);
  const second = prepareManagedCodexHome("run-1", options);

  expect(first.home).not.toBe(second.home);
  expect(first.sessionDir).toBe(second.sessionDir);
  expect(readFileSync(path.join(first.home, "config.toml"), "utf8")).toBe(CURATED_CONFIG_TOML);
  expect(readFileSync(path.join(second.home, "config.toml"), "utf8")).toBe(CURATED_CONFIG_TOML);
  expect(codexAuthLink(first.home)).toBe(realAuthPath);
  expect(readlinkSync(path.join(first.home, "sessions"))).toBe(first.sessionDir);

  const stored = rollout(first.sessionDir, "0199-thread");
  first.cleanup();
  expect(existsSync(first.home)).toBe(false);
  expect(existsSync(second.home)).toBe(true);
  expect(readFileSync(stored, "utf8")).toContain("0199-thread");

  second.cleanup();
  const afterRestart = prepareManagedCodexHome("run-1", options);
  expect(codexSessionFile(afterRestart.sessionDir, "0199-thread")).toBe(stored);
  afterRestart.cleanup();
});

test("Codex accepts only a rollout whose filename and metadata exactly match", () => {
  const prepared = prepareManagedCodexHome("run-1", options);
  const exact = rollout(prepared.sessionDir, "0199-exact");
  rollout(prepared.sessionDir, "0199-other");
  const invalid = path.join(prepared.sessionDir, "rollout-0199-invalid.jsonl");
  writeFileSync(
    invalid,
    `${JSON.stringify({ type: "session_meta", payload: { id: "different" } })}\n`,
  );

  expect(codexSessionFile(prepared.sessionDir, "0199-exact")).toBe(exact);
  expect(codexSessionFile(prepared.sessionDir, "0199-invalid")).toBeUndefined();
  expect(codexSessionFile(prepared.sessionDir, "0199")).toBeUndefined();
  prepared.cleanup();
});

test("a missing real login fails before creating invocation configuration", () => {
  expect(() =>
    prepareManagedCodexHome("run-1", {
      ...options,
      realAuthPath: path.join(tmp, "missing.json"),
    }),
  ).toThrow(/no Codex login found.*codex login/);
  expect(existsSync(managedCodexHomePath("run-1", options))).toBe(false);
});

test("removeManagedCodexHome deletes durable rollouts with the run", () => {
  const prepared = prepareManagedCodexHome("run-1", options);
  rollout(prepared.sessionDir, "0199-thread");
  prepared.cleanup();

  removeManagedCodexHome("run-1", options);

  expect(existsSync(managedCodexHomePath("run-1", options))).toBe(false);
  expect(existsSync(realAuthPath)).toBe(true);
});
