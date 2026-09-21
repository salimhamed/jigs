import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  resolveClaudeExecutable,
  resolveCodexExecutable,
  resolvePiExecutable,
} from "./executables.ts";
import { makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

let tmp: string;
let fakeBin: string;
let emptyDir: string;

beforeEach(() => {
  tmp = makeTmpDir();
  fakeBin = path.join(tmp, "bin");
  emptyDir = path.join(tmp, "empty");
  mkdirSync(fakeBin);
  mkdirSync(emptyDir);
  for (const name of ["claude", "codex", "pi"]) {
    writeFileSync(path.join(fakeBin, name), "#!/bin/sh\n");
    chmodSync(path.join(fakeBin, name), 0o755);
  }
});
afterEach(() => {
  removeTmpDir(tmp);
});

const withBin = () => ({ PATH: [emptyDir, fakeBin].join(path.delimiter) });

test("JIGS_CLAUDE_EXECUTABLE override wins", () => {
  expect(resolveClaudeExecutable({ ...withBin(), JIGS_CLAUDE_EXECUTABLE: "/opt/claude" })).toBe(
    "/opt/claude",
  );
});

test("PATH scan finds an executable claude, skipping dirs without one", () => {
  expect(resolveClaudeExecutable(withBin())).toBe(path.join(fakeBin, "claude"));
});

test("no claude anywhere throws a repair error", () => {
  expect(() => resolveClaudeExecutable({ PATH: emptyDir })).toThrow(
    "no `claude` executable found on PATH",
  );
  expect(() => resolveClaudeExecutable({ PATH: "" })).toThrow("JIGS_CLAUDE_EXECUTABLE");
});

test("PATH scan finds an executable codex, skipping dirs without one", () => {
  expect(resolveCodexExecutable(withBin())).toBe(path.join(fakeBin, "codex"));
});

// No env override to match claude's: a second way to name the binary is a
// second thing the startup check would have to agree with.
test("no codex anywhere throws a repair error", () => {
  expect(() => resolveCodexExecutable({ PATH: emptyDir })).toThrow(
    "no `codex` executable found on PATH",
  );
});

test("PATH scan finds Pi and reports its install package when absent", () => {
  expect(resolvePiExecutable(withBin())).toBe(path.join(fakeBin, "pi"));
  expect(() => resolvePiExecutable({ PATH: emptyDir })).toThrow(
    "install @earendil-works/pi-coding-agent",
  );
});
