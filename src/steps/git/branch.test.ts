import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { pushCommit } from "../../providers/git.ts";
import { git, makeRemoteBackedRepo, makeTmpDir, removeTmpDir } from "../../test-fixtures.ts";
import type { Worktree } from "../../workflow/workspaces/worktree.ts";
import { branchContains, pushApprovedChange, readBranchState, readWorktreeDiff } from "./branch.ts";

let tmp: string;
let checkout: string;
let remoteDir: string;
let approved: string;
let worktree: Worktree;
beforeEach(() => {
  tmp = makeTmpDir();
  ({ checkout, remoteDir } = makeRemoteBackedRepo(tmp));
  git(checkout, "checkout", "-qb", "feature");
  git(checkout, "commit", "--allow-empty", "-qm", "approved work");
  approved = git(checkout, "rev-parse", "HEAD");
  worktree = {
    binding: "app",
    path: checkout,
    branch: "feature",
    defaultBranch: "main",
    baseSha: git(checkout, "rev-parse", "HEAD~1"),
  };
});
afterEach(() => removeTmpDir(tmp));

test("publishes the approved commit and accepts a retry after a successful push", async () => {
  await expect(pushApprovedChange(worktree, approved)).resolves.toEqual({
    headSha: approved,
  });
  await pushApprovedChange(worktree, approved);
  expect(git(remoteDir, "rev-parse", "refs/heads/feature")).toBe(approved);
});

test("rechecks approval after a failed push instead of publishing a later commit", async () => {
  git(checkout, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
  await expect(pushApprovedChange(worktree, approved)).rejects.toThrow();
  git(checkout, "remote", "set-url", "origin", remoteDir);
  git(checkout, "commit", "--allow-empty", "-qm", "unreviewed work");
  await expect(pushApprovedChange(worktree, approved)).rejects.toThrow(
    "is not the approved commit",
  );
  expect(git(remoteDir, "for-each-ref", "refs/heads/feature")).toBe("");
});

test("rejects uncommitted work on every attempt", async () => {
  writeFileSync(path.join(checkout, "unreviewed.txt"), "unreviewed");
  await expect(pushApprovedChange(worktree, approved)).rejects.toThrow("uncommitted changes");
  expect(git(remoteDir, "for-each-ref", "refs/heads/feature")).toBe("");
});

test("the push uses an explicit commit even when HEAD has moved", async () => {
  git(checkout, "commit", "--allow-empty", "-qm", "later work");
  await pushCommit(checkout, "feature", approved);
  expect(git(remoteDir, "rev-parse", "refs/heads/feature")).toBe(approved);
  expect(git(checkout, "rev-parse", "HEAD")).not.toBe(approved);
});

test("a branch contains its head and its ancestors, not a later or unknown commit", async () => {
  const parent = git(checkout, "rev-parse", "HEAD~1");
  git(checkout, "checkout", "-qb", "other", parent);
  git(checkout, "commit", "--allow-empty", "-qm", "someone else's work");
  const elsewhere = git(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "-q", "feature");

  expect(await branchContains(worktree, approved)).toBe(true);
  expect(await branchContains(worktree, parent)).toBe(true);
  expect(await branchContains(worktree, elsewhere)).toBe(false);
  expect(await branchContains(worktree, "0".repeat(40))).toBe(false);
});

test("branch state and diff default to the provisioned base and accept another comparison commit", async () => {
  writeFileSync(path.join(checkout, "first.txt"), "first change\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "first");
  const first = git(checkout, "rev-parse", "HEAD");
  writeFileSync(path.join(checkout, "second.txt"), "second change\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "second");
  const head = git(checkout, "rev-parse", "HEAD");

  expect(await readBranchState(worktree)).toEqual({ commits: 3, headSha: head, dirty: false });
  expect(await readBranchState(worktree, first)).toEqual({
    commits: 1,
    headSha: head,
    dirty: false,
  });
  const full = await readWorktreeDiff(worktree);
  expect(full).toContain("+first change");
  expect(full).toContain("+second change");
  const recent = await readWorktreeDiff(worktree, first);
  expect(recent).not.toContain("first.txt");
  expect(recent).toContain("+second change");
  writeFileSync(path.join(checkout, "uncommitted.txt"), "pending\n");
  expect((await readBranchState(worktree)).dirty).toBe(true);
});
