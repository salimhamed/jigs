import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ClaudeExecutableMissingError,
  claudeStepSettings,
  resolveClaudeExecutable,
} from "./claude.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
let fakeBin: string;

beforeEach(() => {
  tmp = makeTmpDir();
  fakeBin = path.join(tmp, "bin");
  mkdirSync(fakeBin);
  writeFileSync(path.join(fakeBin, "claude"), "#!/bin/sh\n");
  chmodSync(path.join(fakeBin, "claude"), 0o755);
});
afterEach(() => {
  removeTmpDir(tmp);
});

test("JIGS_CLAUDE_EXECUTABLE override wins", () => {
  expect(
    resolveClaudeExecutable({
      JIGS_CLAUDE_EXECUTABLE: "/opt/claude",
      PATH: fakeBin,
    }),
  ).toBe("/opt/claude");
});

test("PATH scan finds an executable claude, skipping non-executable dirs", () => {
  const emptyDir = path.join(tmp, "empty");
  mkdirSync(emptyDir);
  const env = { PATH: [emptyDir, fakeBin].join(path.delimiter) };
  expect(resolveClaudeExecutable(env)).toBe(path.join(fakeBin, "claude"));
});

test("no claude anywhere throws the typed repair error", () => {
  expect(() =>
    resolveClaudeExecutable({ PATH: path.join(tmp, "empty2") }),
  ).toThrow(ClaudeExecutableMissingError);
  expect(() => resolveClaudeExecutable({ PATH: "" })).toThrow(
    "JIGS_CLAUDE_EXECUTABLE",
  );
});

test("claudeStepSettings force-merges the invariants over caller options", () => {
  const settings = claudeStepSettings({
    cwd: "/worktree",
    strictMcpConfig: false,
    settingSources: ["user", "project", "local"],
    pathToClaudeCodeExecutable: "/opt/claude",
  });
  expect(settings.strictMcpConfig).toBe(true);
  expect(settings.settingSources).toEqual(["project"]);
  expect(settings.cwd).toBe("/worktree");
  expect(settings.pathToClaudeCodeExecutable).toBe("/opt/claude");
});

test("claudeStepSettings resolves the executable when not supplied", () => {
  const prev = process.env.JIGS_CLAUDE_EXECUTABLE;
  process.env.JIGS_CLAUDE_EXECUTABLE = "/opt/claude-from-env";
  try {
    expect(
      claudeStepSettings({ cwd: "/worktree" }).pathToClaudeCodeExecutable,
    ).toBe("/opt/claude-from-env");
  } finally {
    if (prev === undefined) delete process.env.JIGS_CLAUDE_EXECUTABLE;
    else process.env.JIGS_CLAUDE_EXECUTABLE = prev;
  }
});
