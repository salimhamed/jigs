import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  git,
  makeClonedBinding,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import {
  applyTeardown,
  decideTeardown,
  isBranchMerged,
  isWorktreeDirty,
} from "./teardown.ts";

test("done (merged) removes the worktree and deletes both branches", () => {
  expect(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: true,
    }),
  ).toEqual({
    removeWorktree: true,
    force: true,
    deleteLocalBranch: true,
    deleteRemoteBranch: true,
    preserve: null,
  });
});

test("an unmerged clean tree removes the worktree and keeps the branches", () => {
  expect(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: false,
    }),
  ).toEqual({
    removeWorktree: true,
    force: false,
    deleteLocalBranch: false,
    deleteRemoteBranch: false,
    preserve: null,
  });
});

test("an unmerged dirty tree is preserved as abandoned-dirty", () => {
  expect(
    decideTeardown({
      keep: false,
      dirty: true,
      merged: false,
    }),
  ).toEqual({
    removeWorktree: false,
    force: false,
    deleteLocalBranch: false,
    deleteRemoteBranch: false,
    preserve: "abandoned-dirty",
  });
});

test("keep: true wins over every row", () => {
  for (const dirty of [false, true]) {
    for (const merged of [false, true]) {
      expect(decideTeardown({ keep: true, dirty, merged })).toEqual({
        removeWorktree: false,
        force: false,
        deleteLocalBranch: false,
        deleteRemoteBranch: false,
        preserve: null,
      });
    }
  }
});

let tmp: string;
let remoteDir: string;
let repoDir: string;
let worktree: string;

beforeEach(() => {
  tmp = makeTmpDir();
  const binding = makeClonedBinding(tmp);
  ({ remoteDir, repoDir } = binding);
  worktree = path.join(binding.worktreesDir, "feat");
  git(
    repoDir,
    "worktree",
    "add",
    "-q",
    worktree,
    "-b",
    "feat",
    "refs/remotes/origin/main",
  );
  writeFileSync(path.join(worktree, "work.txt"), "agent work\n");
  git(worktree, "add", "work.txt");
  git(worktree, "commit", "-q", "-m", "agent work");
  git(worktree, "push", "-q", "origin", "feat");
});
afterEach(() => {
  removeTmpDir(tmp);
});

const target = () => ({
  repoDir,
  worktreePath: worktree,
  branch: "feat",
});
const localBranch = () =>
  git(repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/feat") !== "";
const remoteBranch = () =>
  git(repoDir, "ls-remote", "--heads", "origin", "feat") !== "";

test("done (merged) removes the worktree and deletes the local and remote branches", async () => {
  // Untracked build output is the normal state of a finished worktree.
  writeFileSync(path.join(worktree, "build.log"), "noise\n");
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: true,
    }),
    target(),
  );
  expect(existsSync(worktree)).toBe(false);
  expect(() => localBranch()).toThrow();
  expect(remoteBranch()).toBe(false);
});

test("the remote delete is idempotent when GitHub already deleted the branch on merge", async () => {
  git(remoteDir, "update-ref", "-d", "refs/heads/feat");
  await expect(
    applyTeardown(
      decideTeardown({
        keep: false,
        dirty: false,
        merged: true,
      }),
      target(),
    ),
  ).resolves.toBeUndefined();
  expect(existsSync(worktree)).toBe(false);
  expect(() => localBranch()).toThrow();
});

test("a failed run with a clean tree keeps both branches as insurance", async () => {
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: false,
    }),
    target(),
  );
  expect(existsSync(worktree)).toBe(false);
  expect(localBranch()).toBe(true);
  expect(remoteBranch()).toBe(true);
});

test("a failed run with a dirty tree preserves the worktree untouched and never commits", async () => {
  writeFileSync(path.join(worktree, "work.txt"), "half-finished\n");
  const head = git(worktree, "rev-parse", "HEAD");
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: true,
      merged: false,
    }),
    target(),
  );
  expect(existsSync(worktree)).toBe(true);
  expect(await isWorktreeDirty(worktree)).toBe(true);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
});

test("keep: true leaves the worktree and branches alone", async () => {
  await applyTeardown(
    decideTeardown({
      keep: true,
      dirty: false,
      merged: true,
    }),
    target(),
  );
  expect(existsSync(worktree)).toBe(true);
  expect(localBranch()).toBe(true);
  expect(remoteBranch()).toBe(true);
});

test("removing a worktree prunes the admin entry so the same path can be re-added", async () => {
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: false,
    }),
    target(),
  );
  expect(() =>
    git(repoDir, "worktree", "add", "-q", worktree, "feat"),
  ).not.toThrow();
});

test("a branch origin's default branch does not contain reads unmerged", async () => {
  expect(await isBranchMerged(repoDir, "feat")).toBe(false);
  git(repoDir, "push", "-q", "origin", "feat:main");
  git(repoDir, "fetch", "-q", "origin");
  expect(await isBranchMerged(repoDir, "feat")).toBe(true);
});

test("a clone with no resolvable default branch reads unmerged", async () => {
  git(repoDir, "push", "-q", "origin", "feat:main");
  git(repoDir, "fetch", "-q", "origin");
  // What a clone whose first fetch died before set-head looks like: the work
  // is merged, but with no default branch to compare against it cannot be
  // proven, and branch deletion needs positive evidence.
  git(repoDir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  expect(await isBranchMerged(repoDir, "feat")).toBe(false);
});

test("a clean worktree reads not-dirty and a missing directory does too", async () => {
  expect(await isWorktreeDirty(worktree)).toBe(false);
  expect(await isWorktreeDirty(path.join(tmp, "nowhere"))).toBe(false);
});
