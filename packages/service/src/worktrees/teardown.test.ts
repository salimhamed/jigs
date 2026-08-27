import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { WorktreeRow } from "./registry";
import { teardownRun } from "./teardown";
import { makeFakeSql } from "./test-fixtures";

// Real git worktrees against a faked registry, as sweep.test.ts does: the
// matrix itself is covered in jigs, so what this file proves is the per-run
// join — what a merged run removes, what an unmerged one keeps.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

let tmp: string;
let checkout: string;
let workspace: string;
let store: Map<string, WorktreeRow>;
let removedHomes: string[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-teardown-test-"));
  checkout = path.join(tmp, "checkout");
  workspace = path.join(tmp, "workspace");
  const remote = path.join(tmp, "remote.git");
  for (const dir of [checkout, workspace, remote]) {
    mkdirSync(dir, { recursive: true });
  }
  git(remote, "init", "-q", "--bare", "--initial-branch", "main");
  git(checkout, "init", "-q", "--initial-branch", "main");
  git(checkout, "config", "user.name", "jigs-fixture");
  git(checkout, "config", "user.email", "fixture@jigs.test");
  git(checkout, "remote", "add", "origin", remote);
  writeFileSync(path.join(checkout, "README.md"), "# fixture\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-q", "-m", "initial");
  git(checkout, "push", "-q", "-u", "origin", "main");
  git(checkout, "remote", "set-head", "origin", "main");
  store = new Map();
  removedHomes = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// A worktree with a commit of its own, pushed to origin — the shape a run's
// branch is in by the time the review loop reaches its teardown.
function runWorktree(branch: string, runId = "run_1"): string {
  const target = path.join(workspace, branch);
  git(checkout, "worktree", "add", "-q", target, "-b", branch);
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
    checkoutRoot: checkout,
    keep: false,
  });
  return target;
}

const deps = (overrides: Record<string, unknown> = {}) => ({
  sql: makeFakeSql(store),
  bindings: () => [],
  fastForward: async () => ({
    moved: false,
    skipped: "already-current" as const,
  }),
  removeCodexHome: (runKey: string) => removedHomes.push(runKey),
  log: () => {},
  ...overrides,
});

const localBranches = () =>
  git(checkout, "branch", "--list", "--format=%(refname:short)");
const remoteBranches = () => git(checkout, "ls-remote", "--heads", "origin");

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
  // silently degrade to the failed one.
  git(checkout, "merge", "--squash", "feature");
  git(checkout, "commit", "-q", "-m", "squashed feature (#41)");
  git(checkout, "push", "-q", "origin", "main");
  git(checkout, "fetch", "-q", "origin");
  expect(() =>
    git(checkout, "merge-base", "--is-ancestor", "feature", "origin/main"),
  ).toThrow();

  await teardownRun("run_1", { merged: true }, deps());

  expect(existsSync(target)).toBe(false);
  expect(localBranches().split("\n")).not.toContain("feature");
  expect(remoteBranches()).not.toContain("refs/heads/feature");
});

test("a merged run fast-forwards the checkout's default branch first", async () => {
  runWorktree("feature");
  const ffCalls: Array<{ checkoutRoot: string; enabled?: boolean }> = [];

  await teardownRun(
    "run_1",
    { merged: true },
    deps({
      fastForward: async (options: {
        checkoutRoot: string;
        enabled?: boolean;
      }) => {
        ffCalls.push(options);
        return { moved: false, skipped: "already-current" as const };
      },
    }),
  );

  expect(ffCalls).toEqual([{ checkoutRoot: checkout, enabled: true }]);
});

test("a binding with ff_default_branch: false freezes its checkout's default", async () => {
  runWorktree("feature");
  const ffCalls: Array<{ enabled?: boolean }> = [];

  await teardownRun(
    "run_1",
    { merged: true },
    deps({
      bindings: () => [
        {
          name: "scratch",
          checkoutRoot: checkout,
          remote: "git@github.com:acme/api.git",
          ffDefaultBranch: false,
        },
      ],
      fastForward: async (options: { enabled?: boolean }) => {
        ffCalls.push(options);
        return { moved: false, skipped: "disabled" as const };
      },
    }),
  );

  expect(ffCalls).toEqual([{ checkoutRoot: checkout, enabled: false }]);
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
