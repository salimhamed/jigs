import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  git,
  makeRemoteBackedRepo,
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
let checkout: string;
let worktree: string;

beforeEach(() => {
  tmp = makeTmpDir();
  ({ remoteDir, checkout } = makeRemoteBackedRepo(tmp));
  worktree = path.join(tmp, "wt", "feat");
  git(checkout, "worktree", "add", "-q", worktree, "-b", "feat");
  writeFileSync(path.join(worktree, "work.txt"), "agent work\n");
  git(worktree, "add", "work.txt");
  git(worktree, "commit", "-q", "-m", "agent work");
  git(worktree, "push", "-q", "origin", "feat");
});
afterEach(() => {
  removeTmpDir(tmp);
});

const target = () => ({
  checkoutRoot: checkout,
  worktreePath: worktree,
  branch: "feat",
});
const localBranch = () =>
  git(checkout, "rev-parse", "--verify", "--quiet", "refs/heads/feat") !== "";
const remoteBranch = () =>
  git(checkout, "ls-remote", "--heads", "origin", "feat") !== "";

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
    git(checkout, "worktree", "add", "-q", worktree, "feat"),
  ).not.toThrow();
});

test("a branch origin's default branch does not contain reads unmerged", async () => {
  expect(await isBranchMerged(checkout, "feat")).toBe(false);
  git(checkout, "push", "-q", "origin", "feat:main");
  git(checkout, "fetch", "-q", "origin");
  expect(await isBranchMerged(checkout, "feat")).toBe(true);
});

test("a checkout with no resolvable default branch reads unmerged", async () => {
  expect(await isBranchMerged(path.join(tmp, "nowhere"), "feat")).toBe(false);
});

test("a clean worktree reads not-dirty and a missing directory does too", async () => {
  expect(await isWorktreeDirty(worktree)).toBe(false);
  expect(await isWorktreeDirty(path.join(tmp, "nowhere"))).toBe(false);
});
