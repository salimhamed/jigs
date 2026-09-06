import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { WorktreeRow } from "./registry";
import {
  applyTeardown,
  decideTeardown,
  isBranchMerged,
  isWorktreeDirty,
  teardownRun,
} from "./teardown";
import { git, makeClonedBinding, makeFakeSql } from "./test-fixtures";

// The teardown matrix (ADR 0007) three ways: the pure decision as a table,
// its git execution against a real worktree, then the per-run join
// teardownRun makes against a faked registry — what a merged run removes,
// what an unmerged one keeps.

let tmp: string;
let repoDir: string;
let remoteDir: string;
let worktreesDir: string;
let store: Map<string, WorktreeRow>;
let removedHomes: string[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-teardown-test-"));
  ({ repoDir, remoteDir, worktreesDir } = makeClonedBinding(tmp));
  store = new Map();
  removedHomes = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// A worktree with a commit of its own, pushed to origin — the shape a run's
// branch is in by the time the review loop reaches its teardown.
function runWorktree(branch: string, runId = "run_1"): string {
  const target = path.join(worktreesDir, branch);
  git(
    repoDir,
    "worktree",
    "add",
    "-q",
    target,
    "-b",
    branch,
    "refs/remotes/origin/main",
  );
  writeFileSync(path.join(target, "shipped.txt"), "shipped\n");
  git(target, "add", "shipped.txt");
  git(target, "commit", "-q", "-m", "agent work");
  git(target, "push", "-q", "-u", "origin", branch);
  store.set(target, {
    path: target,
    branch,
    ownerRunId: runId,
    state: "active",
    baseSha: "base1",
    headSha: "head1",
    behindDefault: 0,
    repoDir,
    keep: false,
  });
  return target;
}

const deps = (overrides: Record<string, unknown> = {}) => ({
  sql: makeFakeSql(store),
  removeCodexHome: (runKey: string) => removedHomes.push(runKey),
  log: () => {},
  ...overrides,
});

const localBranches = () =>
  git(repoDir, "branch", "--list", "--format=%(refname:short)");
const remoteBranches = () => git(repoDir, "ls-remote", "--heads", "origin");

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

// applyTeardown against the "feat" worktree runWorktree cuts, without the
// registry: the plan is the matrix's, the target is the tree on disk.
const featTarget = (worktree: string) => ({
  repoDir,
  worktreePath: worktree,
  branch: "feat",
});
const featLocal = () =>
  git(repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/feat") !== "";
const featRemote = () =>
  git(repoDir, "ls-remote", "--heads", "origin", "feat") !== "";

test("applying the merged row removes the worktree and deletes the local and remote branches", async () => {
  const worktree = runWorktree("feat");
  // Untracked build output is the normal state of a finished worktree.
  writeFileSync(path.join(worktree, "build.log"), "noise\n");
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: true,
    }),
    featTarget(worktree),
  );
  expect(existsSync(worktree)).toBe(false);
  expect(() => featLocal()).toThrow();
  expect(featRemote()).toBe(false);
});

test("the remote delete is idempotent when GitHub already deleted the branch on merge", async () => {
  const worktree = runWorktree("feat");
  git(remoteDir, "update-ref", "-d", "refs/heads/feat");
  await expect(
    applyTeardown(
      decideTeardown({
        keep: false,
        dirty: false,
        merged: true,
      }),
      featTarget(worktree),
    ),
  ).resolves.toBeUndefined();
  expect(existsSync(worktree)).toBe(false);
  expect(() => featLocal()).toThrow();
});

test("a merged teardown prunes the tracking ref delete-on-merge left behind", async () => {
  const worktree = runWorktree("feat");
  // The push in runWorktree wrote refs/remotes/origin/feat; GitHub deleting
  // the branch on merge is what leaves it with nothing behind it.
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/feat")).not.toBe("");
  git(remoteDir, "update-ref", "-d", "refs/heads/feat");

  await applyTeardown(
    decideTeardown({ keep: false, dirty: false, merged: true }),
    featTarget(worktree),
  );
  expect(() => git(repoDir, "rev-parse", "refs/remotes/origin/feat")).toThrow();
});

test("a failed run with a clean tree keeps both branches as insurance", async () => {
  const worktree = runWorktree("feat");
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: false,
    }),
    featTarget(worktree),
  );
  expect(existsSync(worktree)).toBe(false);
  expect(featLocal()).toBe(true);
  expect(featRemote()).toBe(true);
});

test("a failed run with a dirty tree preserves the worktree untouched and never commits", async () => {
  const worktree = runWorktree("feat");
  writeFileSync(path.join(worktree, "shipped.txt"), "half-finished\n");
  const head = git(worktree, "rev-parse", "HEAD");
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: true,
      merged: false,
    }),
    featTarget(worktree),
  );
  expect(existsSync(worktree)).toBe(true);
  expect(await isWorktreeDirty(worktree)).toBe(true);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
});

test("keep: true leaves the worktree and branches alone", async () => {
  const worktree = runWorktree("feat");
  await applyTeardown(
    decideTeardown({
      keep: true,
      dirty: false,
      merged: true,
    }),
    featTarget(worktree),
  );
  expect(existsSync(worktree)).toBe(true);
  expect(featLocal()).toBe(true);
  expect(featRemote()).toBe(true);
});

test("removing a worktree prunes the admin entry so the same path can be re-added", async () => {
  const worktree = runWorktree("feat");
  await applyTeardown(
    decideTeardown({
      keep: false,
      dirty: false,
      merged: false,
    }),
    featTarget(worktree),
  );
  expect(() =>
    git(repoDir, "worktree", "add", "-q", worktree, "feat"),
  ).not.toThrow();
});

test("a branch origin's default branch does not contain reads unmerged", async () => {
  runWorktree("feat");
  expect(await isBranchMerged(repoDir, "feat")).toBe(false);
  git(repoDir, "push", "-q", "origin", "feat:main");
  git(repoDir, "fetch", "-q", "origin");
  expect(await isBranchMerged(repoDir, "feat")).toBe(true);
});

test("a clone with no resolvable default branch reads unmerged", async () => {
  runWorktree("feat");
  git(repoDir, "push", "-q", "origin", "feat:main");
  git(repoDir, "fetch", "-q", "origin");
  // What a clone whose first fetch died before set-head looks like: the work
  // is merged, but with no default branch to compare against it cannot be
  // proven, and branch deletion needs positive evidence.
  git(repoDir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  expect(await isBranchMerged(repoDir, "feat")).toBe(false);
});

test("a clean worktree reads not-dirty and a missing directory does too", async () => {
  const worktree = runWorktree("feat");
  expect(await isWorktreeDirty(worktree)).toBe(false);
  expect(await isWorktreeDirty(path.join(tmp, "nowhere"))).toBe(false);
});

test("a merged run removes the worktree and both branches", async () => {
  const target = runWorktree("feature");

  const removed = await teardownRun("run_1", { merged: true }, deps());

  expect(removed).toEqual([target]);
  expect(existsSync(target)).toBe(false);
  expect(localBranches().split("\n")).not.toContain("feature");
  expect(remoteBranches()).not.toContain("refs/heads/feature");
  expect(store.size).toBe(0);
  expect(removedHomes).toEqual(["run_1"]);
});

test("a squash-merged branch is torn down even though it is not an ancestor of the default branch", async () => {
  const target = runWorktree("feature");
  // A squash merge on origin: the work lands, the branch tip does not, so
  // `merge-base --is-ancestor` would answer false and the done row would
  // silently degrade to the failed one. Built with plumbing because the clone
  // is bare and has no index to merge in.
  const squashed = git(
    repoDir,
    "commit-tree",
    "feature^{tree}",
    "-p",
    "refs/remotes/origin/main",
    "-m",
    "squashed feature (#41)",
  );
  git(repoDir, "push", "-q", "origin", `${squashed}:refs/heads/main`);
  git(repoDir, "fetch", "-q", "origin");
  expect(() =>
    git(repoDir, "merge-base", "--is-ancestor", "feature", "origin/main"),
  ).toThrow();

  await teardownRun("run_1", { merged: true }, deps());

  expect(existsSync(target)).toBe(false);
  expect(localBranches().split("\n")).not.toContain("feature");
  expect(remoteBranches()).not.toContain("refs/heads/feature");
});

test("a merged run's dirty tree still goes — the matrix's forced row", async () => {
  const target = runWorktree("feature");
  writeFileSync(path.join(target, "build.log"), "output\n");

  await teardownRun("run_1", { merged: true }, deps());

  expect(existsSync(target)).toBe(false);
  expect(localBranches().split("\n")).not.toContain("feature");
});

test("an unmerged clean tree is removed and both branches survive", async () => {
  const target = runWorktree("feature");

  const removed = await teardownRun("run_1", { merged: false }, deps());

  expect(removed).toEqual([target]);
  expect(existsSync(target)).toBe(false);
  // The branch is the only cheap copy of unmerged agent work.
  expect(localBranches().split("\n")).toContain("feature");
  expect(remoteBranches()).toContain("refs/heads/feature");
  expect(store.size).toBe(0);
});

test("an unmerged dirty tree is preserved and marked abandoned-dirty", async () => {
  const target = runWorktree("feature");
  writeFileSync(path.join(target, "wip.txt"), "half-finished\n");

  const removed = await teardownRun("run_1", { merged: false }, deps());

  expect(removed).toEqual([]);
  expect(existsSync(target)).toBe(true);
  expect(store.get(target)?.state).toBe("abandoned-dirty");
});

test("keep: true keeps everything, merged or not", async () => {
  const target = runWorktree("feature");
  const row = store.get(target);
  if (row !== undefined) store.set(target, { ...row, keep: true });

  const removed = await teardownRun("run_1", { merged: true }, deps());

  expect(removed).toEqual([]);
  expect(existsSync(target)).toBe(true);
  expect(localBranches().split("\n")).toContain("feature");
  expect(store.size).toBe(1);
});

test("only the run's own worktrees are torn down", async () => {
  const mine = runWorktree("mine", "run_1");
  const theirs = runWorktree("theirs", "run_2");

  await teardownRun("run_1", { merged: true }, deps());

  expect(existsSync(mine)).toBe(false);
  expect(existsSync(theirs)).toBe(true);
  expect([...store.keys()]).toEqual([theirs]);
});
