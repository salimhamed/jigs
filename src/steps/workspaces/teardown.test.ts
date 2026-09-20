import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { managedCodexHomePath } from "../agents/harnesses/codex-home.ts";
import { createRunDirectory } from "../runtime/run-directory/index.ts";
import type { WorktreeRow } from "./registry.ts";
import { releaseRunResources } from "./release.ts";
import {
  applyTeardown,
  countUnmergedCommits,
  decideTeardown,
  isWorktreeDirty,
} from "./teardown.ts";
import { git, makeClonedBinding, makeFakeSql } from "./test-fixtures.ts";

// The teardown matrix three ways: the pure decision as a table, its git
// execution against a real worktree, then policy-driven release against a
// faked registry: what is removed, preserved, and reported.

let tmp: string;
let repoDir: string;
let remoteDir: string;
let worktreesDir: string;
let store: Map<string, WorktreeRow>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-teardown-test-"));
  // The managed Codex homes the teardown removes hang off the data home.
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  ({ repoDir, remoteDir, worktreesDir } = makeClonedBinding(tmp));
  store = new Map();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

// A worktree with a commit of its own, pushed to origin — the shape a run's
// branch is in by the time the review loop reaches its teardown.
function runWorktree(branch: string, runId = "run_1"): string {
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  writeFileSync(path.join(target, "shipped.txt"), "shipped\n");
  git(target, "add", "shipped.txt");
  git(target, "commit", "-q", "-m", "agent work");
  git(target, "push", "-q", "-u", "origin", branch);
  store.set(target, {
    path: target,
    branch,
    ownerRunId: runId,
    state: "active",
    repoDir,
  });
  return target;
}

const registry = () => makeFakeSql(store);
const release = () =>
  releaseRunResources(
    { onSuccess: "release", onFailure: "keep" },
    { workflowRunId: "run_1" },
    registry(),
  );
function merge(branch: string) {
  git(repoDir, "push", "-q", "origin", `${branch}:main`);
  git(repoDir, "fetch", "-q", "origin");
}

function codexHome(runId: string): string {
  const home = managedCodexHomePath(runId);
  mkdirSync(home, { recursive: true });
  return home;
}

const localBranches = () => git(repoDir, "branch", "--list", "--format=%(refname:short)");
const remoteBranches = () => git(repoDir, "ls-remote", "--heads", "origin");

// Merged, not completed: resource release asks the ancestry question of every
// terminal run, so a cancelled run's empty branch reaches this row too — with
// the remote delete suppressed there, which release must withhold.
test("a merged branch removes the worktree and deletes both branches", () => {
  expect(
    decideTeardown({
      dirty: false,
      unmergedCommits: 0,
    }),
  ).toEqual({
    removeWorktree: true,
    force: true,
    deleteLocalBranch: true,
    deleteRemoteBranch: true,
    preserve: null,
  });
});

test("dirtiness outranks a merged branch", () => {
  expect(decideTeardown({ dirty: true, unmergedCommits: 0 })).toEqual({
    removeWorktree: false,
    force: false,
    deleteLocalBranch: false,
    deleteRemoteBranch: false,
    preserve: "abandoned-dirty",
  });
});

test("an unmerged clean tree removes the worktree and keeps the branches", () => {
  expect(
    decideTeardown({
      dirty: false,
      unmergedCommits: 1,
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
      dirty: true,
      unmergedCommits: 1,
    }),
  ).toEqual({
    removeWorktree: false,
    force: false,
    deleteLocalBranch: false,
    deleteRemoteBranch: false,
    preserve: "abandoned-dirty",
  });
});

// applyTeardown against the "feat" worktree runWorktree cuts, without the
// registry: the plan is the matrix's, the target is the tree on disk.
const featTarget = (worktree: string) => ({
  repoDir,
  worktreePath: worktree,
  branch: "feat",
});
const featLocal = () => git(repoDir, "rev-parse", "--verify", "--quiet", "refs/heads/feat") !== "";
const featRemote = () => git(repoDir, "ls-remote", "--heads", "origin", "feat") !== "";

test("applying the merged row removes the worktree and deletes the local and remote branches", async () => {
  const worktree = runWorktree("feat");
  merge("feat");
  // Untracked build output is the normal state of a finished worktree.
  writeFileSync(path.join(worktree, "build.log"), "noise\n");
  await applyTeardown(
    decideTeardown({
      dirty: false,
      unmergedCommits: 0,
    }),
    featTarget(worktree),
  );
  expect(existsSync(worktree)).toBe(false);
  expect(() => featLocal()).toThrow();
  expect(featRemote()).toBe(false);
});

test("the remote delete is idempotent when GitHub already deleted the branch on merge", async () => {
  const worktree = runWorktree("feat");
  merge("feat");
  git(remoteDir, "update-ref", "-d", "refs/heads/feat");
  await expect(
    applyTeardown(
      decideTeardown({
        dirty: false,
        unmergedCommits: 0,
      }),
      featTarget(worktree),
    ),
  ).resolves.toMatchObject({ localBranchDeleted: true });
  expect(existsSync(worktree)).toBe(false);
  expect(() => featLocal()).toThrow();
});

test("a merged teardown prunes the tracking ref delete-on-merge left behind", async () => {
  const worktree = runWorktree("feat");
  // The push in runWorktree wrote refs/remotes/origin/feat; GitHub deleting
  // the branch on merge is what leaves it with nothing behind it.
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/feat")).not.toBe("");
  merge("feat");
  git(remoteDir, "update-ref", "-d", "refs/heads/feat");

  await applyTeardown(decideTeardown({ dirty: false, unmergedCommits: 0 }), featTarget(worktree));
  expect(() => git(repoDir, "rev-parse", "refs/remotes/origin/feat")).toThrow();
});

test("a failed run with a clean tree keeps both branches as insurance", async () => {
  const worktree = runWorktree("feat");
  await applyTeardown(
    decideTeardown({
      dirty: false,
      unmergedCommits: 1,
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
      dirty: true,
      unmergedCommits: 1,
    }),
    featTarget(worktree),
  );
  expect(existsSync(worktree)).toBe(true);
  expect(await isWorktreeDirty(worktree)).toBe(true);
  expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
});

test("removing a worktree prunes the admin entry so the same path can be re-added", async () => {
  const worktree = runWorktree("feat");
  await applyTeardown(
    decideTeardown({
      dirty: false,
      unmergedCommits: 1,
    }),
    featTarget(worktree),
  );
  expect(() => git(repoDir, "worktree", "add", "-q", worktree, "feat")).not.toThrow();
});

test("a branch origin's default branch does not contain counts its commits", async () => {
  runWorktree("feat");
  expect(await countUnmergedCommits(repoDir, "feat")).toBe(1);
  git(repoDir, "push", "-q", "origin", "feat:main");
  git(repoDir, "fetch", "-q", "origin");
  expect(await countUnmergedCommits(repoDir, "feat")).toBe(0);
});

test("a clone with no resolvable default branch answers nothing", async () => {
  runWorktree("feat");
  git(repoDir, "push", "-q", "origin", "feat:main");
  git(repoDir, "fetch", "-q", "origin");
  // What a clone whose first fetch died before set-head looks like: the work
  // is merged, but with no default branch to compare against it cannot be
  // proven, and branch deletion needs positive evidence.
  git(repoDir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  expect(await countUnmergedCommits(repoDir, "feat")).toBeNull();
});

test("a clean worktree reads not-dirty; unreadable or missing directories are not assumed clean", async () => {
  const worktree = runWorktree("feat");
  expect(await isWorktreeDirty(worktree)).toBe(false);
  expect(await isWorktreeDirty(path.join(tmp, "nowhere"))).toBe(true);
});

test("a merged run removes the worktree, both branches, and its Codex home", async () => {
  const target = runWorktree("feature");
  const home = codexHome("run_1");
  merge("feature");

  const removed = await release();

  expect(removed.worktrees.map((resource) => resource.removed && resource.path)).toEqual([target]);
  expect(existsSync(target)).toBe(false);
  expect(localBranches().split("\n")).not.toContain("feature");
  expect(remoteBranches()).not.toContain("refs/heads/feature");
  expect(store.size).toBe(0);
  // The run is finishing: nothing will resume its Codex threads.
  expect(existsSync(home)).toBe(false);
});

test("a squash-merged clean worktree is released but its unproven branches remain", async () => {
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
  expect(() => git(repoDir, "merge-base", "--is-ancestor", "feature", "origin/main")).toThrow();

  await release();

  expect(existsSync(target)).toBe(false);
  expect(localBranches().split("\n")).toContain("feature");
  expect(remoteBranches()).toContain("refs/heads/feature");
});

test("a proven merged run still preserves a dirty tree", async () => {
  const target = runWorktree("feature");
  writeFileSync(path.join(target, "build.log"), "output\n");
  merge("feature");

  await release();

  expect(existsSync(target)).toBe(true);
  expect(localBranches().split("\n")).toContain("feature");
  expect(store.get(target)?.state).toBe("abandoned-dirty");
});

test("only the run's own worktrees are torn down", async () => {
  const mine = runWorktree("mine", "run_1");
  const theirs = runWorktree("theirs", "run_2");

  await release();

  expect(existsSync(mine)).toBe(false);
  expect(existsSync(theirs)).toBe(true);
  expect([...store.keys()]).toEqual([theirs]);
});

test.each([null, 1, 5])("%s unmerged commits never permit branch deletion", (unmergedCommits) => {
  for (const dirty of [true, false]) {
    const plan = decideTeardown({ dirty, unmergedCommits });
    expect(plan.deleteLocalBranch).toBe(false);
    expect(plan.deleteRemoteBranch).toBe(false);
  }
});

test("keep policy preserves every run resource and reports why", async () => {
  const target = runWorktree("feature");
  const directory = await createRunDirectory({ workflowRunId: "run_1" });
  const result = await releaseRunResources(
    { onSuccess: "keep", onFailure: "release" },
    { workflowRunId: "run_1" },
    registry(),
  );
  expect(result.worktrees[0]).toMatchObject({
    path: target,
    removed: false,
    reason: "onSuccess policy keeps run resources",
  });
  expect(result.runDirectory.removed).toBe(false);
  expect(existsSync(directory)).toBe(true);
  expect(store.size).toBe(1);
});

test("success releases its run directory even with no worktree", async () => {
  const directory = await createRunDirectory({ workflowRunId: "run_1" });
  const result = await release();
  expect(result.runDirectory).toMatchObject({ path: directory, removed: true });
  expect(existsSync(directory)).toBe(false);
});

test("unmerged dirty work is preserved and explained", async () => {
  const target = runWorktree("feature");
  writeFileSync(path.join(target, "wip"), "in progress");
  const result = await release();
  expect(result.worktrees[0]).toMatchObject({ removed: false, unmergedCommits: 1 });
  expect(result.worktrees[0]?.reason).toContain("uncommitted");
  expect(store.get(target)?.state).toBe("abandoned-dirty");
  expect(existsSync(target)).toBe(true);
});

test("failed removal retains the directory and registry row", async () => {
  const target = runWorktree("feature");
  git(repoDir, "worktree", "lock", target);
  const result = await release();
  expect(result.worktrees[0]?.removed).toBe(false);
  expect(result.worktrees[0]?.reason).toContain("release incomplete");
  expect(existsSync(target)).toBe(true);
  expect(store.has(target)).toBe(true);
});

test("failed fetch cannot authorize branch deletion using a stale merged ref", async () => {
  const target = runWorktree("feature");
  merge("feature");
  git(repoDir, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
  const result = await release();
  expect(result.worktrees[0]).toMatchObject({
    removed: true,
    localBranchDeleted: false,
    remoteBranchDeleted: false,
    unmergedCommits: null,
  });
  expect(existsSync(target)).toBe(false);
  expect(localBranches()).toContain("feature");
});

test("a remotely advanced branch stays even when the local branch is merged", async () => {
  runWorktree("feature");
  merge("feature");
  const sha = git(
    repoDir,
    "commit-tree",
    "feature^{tree}",
    "-p",
    "feature",
    "-m",
    "remote-only work",
  );
  git(repoDir, "push", "-q", "origin", `${sha}:feature`);
  const result = await release();
  expect(result.worktrees[0]).toMatchObject({
    removed: true,
    localBranchDeleted: true,
    remoteBranchDeleted: false,
  });
  expect(remoteBranches()).toContain("refs/heads/feature");
});
