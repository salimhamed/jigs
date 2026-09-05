import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CliError } from "../errors.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import {
  DEFAULT_WORKTREE_CONFIG,
  parseTargetConfig,
  readTargetConfig,
  resolveWorktreeConfig,
  TARGET_CONFIG_FILE,
} from "./target-config.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

const write = (text: string) =>
  writeFileSync(path.join(tmp, TARGET_CONFIG_FILE), text);

test("a directory with no .jigs.yml reads as schema defaults", () => {
  expect(readTargetConfig(tmp).worktree).toEqual({
    copy: [],
    post_create: [],
    hook_timeout_minutes: 10,
  });
});

test("an empty worktree section defaults hook_timeout_minutes to 10", () => {
  write("worktree:\n  copy: [.env]\n");
  const config = readTargetConfig(tmp);
  expect(config.worktree.copy).toEqual([".env"]);
  expect(config.worktree.hook_timeout_minutes).toBe(10);
});

test("an explicit hook_timeout_minutes overrides the default", () => {
  write("worktree:\n  hook_timeout_minutes: 2\n");
  expect(readTargetConfig(tmp).worktree.hook_timeout_minutes).toBe(2);
});

test("an unknown key under worktree: is rejected", () => {
  const failure = (() => {
    try {
      parseTargetConfig("worktree:\n  copyy: [.env]\n");
      return null;
    } catch (err) {
      return err;
    }
  })();
  expect(failure).toBeInstanceOf(CliError);
  expect((failure as CliError).message).toContain("invalid .jigs.yml:");
  expect((failure as CliError).message).toContain(
    'worktree: Unrecognized key: "copyy"',
  );
});

test("keys the target repo owns outside worktree: are left alone", () => {
  expect(parseTargetConfig("something_else: true\n")).toMatchObject({
    something_else: true,
  });
});

test("malformed YAML raises the invalid .jigs.yml CliError", () => {
  expect(() => parseTargetConfig("worktree: [unclosed\n")).toThrow(
    /invalid \.jigs\.yml:/,
  );
});

test("a non-positive hook_timeout_minutes is rejected", () => {
  expect(() =>
    parseTargetConfig("worktree:\n  hook_timeout_minutes: 0\n"),
  ).toThrow(CliError);
});

// ---- seed-first resolution -------------------------------------------------

function makeDirs(): { seedDir: string; worktreePath: string } {
  const seedDir = path.join(tmp, "seed");
  const worktreePath = path.join(tmp, "wt");
  for (const dir of [seedDir, worktreePath])
    mkdirSync(dir, { recursive: true });
  return { seedDir, worktreePath };
}

test("the seed directory's .jigs.yml wins over the worktree's", () => {
  const dirs = makeDirs();
  writeFileSync(
    path.join(dirs.seedDir, TARGET_CONFIG_FILE),
    "worktree:\n  copy: [.env]\n  post_create: [npm ci]\n",
  );
  writeFileSync(
    path.join(dirs.worktreePath, TARGET_CONFIG_FILE),
    "worktree:\n  copy: []\n",
  );
  expect(resolveWorktreeConfig(dirs)).toMatchObject({
    copy: [".env"],
    post_create: ["npm ci"],
  });
});

test("without a seeded file the worktree's own committed one is read", () => {
  const dirs = makeDirs();
  writeFileSync(
    path.join(dirs.worktreePath, TARGET_CONFIG_FILE),
    "worktree:\n  post_create: [pnpm install]\n",
  );
  expect(resolveWorktreeConfig(dirs)).toMatchObject({
    post_create: ["pnpm install"],
  });
});

test("neither file resolves to null, so the caller can say so", () => {
  expect(resolveWorktreeConfig(makeDirs())).toBeNull();
  expect(DEFAULT_WORKTREE_CONFIG).toEqual({
    copy: [],
    post_create: [],
    hook_timeout_minutes: 10,
  });
});
