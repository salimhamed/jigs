import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { countUnmergedCommits, isWorktreeDirty } from "../workspaces/git-safety.ts";
import { git, makeClonedBinding } from "../workspaces/test-fixtures.ts";
import type { ResourceRow } from "./registry.ts";
import { decideRelease } from "./resource-kinds.ts";

type Run = Parameters<typeof decideRelease>[1];

// What release would do, and then does: the decision, run when it is a removal.
async function releaseResource(row: ResourceRow, run: Run) {
  const decided = await decideRelease(row, run);
  return typeof decided === "function" ? decided() : decided;
}

/** Why release would leave the resource, or null when it would remove it. */
async function refusal(row: ResourceRow, run: Run) {
  const decided = await decideRelease(row, run);
  return typeof decided === "function" ? null : decided;
}

// Each kind's release against the real thing it deletes: git worktrees in a
// real clone, and GitHub branches through a faked API.

let tmp: string;
let repoDir: string;
let worktreesDir: string;
const fetchMock = vi.fn();
const at = new Date("2026-09-25T00:00:00.000Z");

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "jigs-kinds-test-"));
  vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
  vi.stubEnv("GITHUB_TOKEN", "gh_test_token");
  vi.stubEnv("GITHUB_API_URL", "http://mock.test/github");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  ({ repoDir, worktreesDir } = makeClonedBinding(tmp));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

function row(kind: string, identity: string, over: Partial<ResourceRow> = {}): ResourceRow {
  return {
    factory: "factory-a",
    runId: "wrun_1",
    kind,
    identity,
    url: "https://example.test/",
    state: "live",
    reason: null,
    attempts: 0,
    repoDir: null,
    branch: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

// A worktree with a commit of its own, pushed to origin: the shape a run's
// branch is in by the time its run ends.
function runWorktree(branch: string): ResourceRow {
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  writeFileSync(path.join(target, "shipped.txt"), "shipped\n");
  git(target, "add", "shipped.txt");
  git(target, "commit", "-q", "-m", "agent work");
  git(target, "push", "-q", "-u", "origin", branch);
  return row("worktree", target, { repoDir, branch });
}

function merge(branch: string) {
  git(repoDir, "push", "-q", "origin", `${branch}:main`);
  git(repoDir, "fetch", "-q", "origin");
}

const localBranches = () => git(repoDir, "branch", "--list", "--format=%(refname:short)");

test("a merged worktree is removed with its local branch", async () => {
  const tree = runWorktree("feat");
  merge("feat");

  expect(await releaseResource(tree, [])).toEqual({
    state: "released",
    reason: "worktree and merged branch removed",
  });
  expect(existsSync(tree.identity)).toBe(false);
  expect(localBranches()).not.toContain("feat");
  expect(() => git(repoDir, "worktree", "add", "-q", tree.identity, "main")).not.toThrow();
});

test("an unmerged clean worktree is removed but its branch keeps the commits", async () => {
  const tree = runWorktree("feat");

  expect(await releaseResource(tree, [])).toEqual({
    state: "released",
    reason: "worktree removed; branch kept with 1 unmerged commit(s)",
  });
  expect(existsSync(tree.identity)).toBe(false);
  expect(localBranches()).toContain("feat");
});

test("a dirty worktree is kept untouched, even when its branch is merged", async () => {
  const tree = runWorktree("feat");
  merge("feat");
  writeFileSync(path.join(tree.identity, "notes.txt"), "uncommitted\n");

  expect(await refusal(tree, [])).toEqual({ state: "kept", reason: "uncommitted work kept" });
  expect(await releaseResource(tree, [])).toEqual({
    state: "kept",
    reason: "uncommitted work kept",
  });
  expect(existsSync(path.join(tree.identity, "notes.txt"))).toBe(true);
  expect(localBranches()).toContain("feat");
});

test("a failed fetch cannot authorize branch deletion from a stale merged ref", async () => {
  const tree = runWorktree("feat");
  merge("feat");
  git(repoDir, "remote", "set-url", "origin", path.join(tmp, "missing.git"));

  expect(await releaseResource(tree, [])).toEqual({
    state: "released",
    reason: "worktree removed; branch kept because its ancestry could not be verified",
  });
  expect(localBranches()).toContain("feat");
});

test("a worktree already gone from disk is released and its admin entry pruned", async () => {
  const tree = runWorktree("feat");
  rmSync(tree.identity, { recursive: true, force: true });

  expect((await releaseResource(tree, [])).state).toBe("released");
  expect(git(repoDir, "worktree", "list")).not.toContain(tree.identity);
});

test("a git failure during removal throws, and the tree stays", async () => {
  const tree = runWorktree("feat");
  git(repoDir, "worktree", "lock", tree.identity);

  await expect(releaseResource(tree, [])).rejects.toThrow();
  expect(existsSync(tree.identity)).toBe(true);
});

test("harness homes wait for a live or failed worktree and stay with a kept one", async () => {
  const home = row("codex-home", "wrun_1");
  expect(await refusal(home, [{ kind: "worktree", state: "kept" }])).toEqual({
    state: "kept",
    reason: "kept with the run's worktree",
  });
  for (const state of ["live", "failed"] as const) {
    expect(await refusal(home, [{ kind: "worktree", state }])).toEqual({
      state: "live",
      reason: "waits for the run's worktree",
    });
  }
  expect(await refusal(home, [{ kind: "worktree", state: "released" }])).toBeNull();
});

test("recorded-only kinds are never dispatched", async () => {
  await expect(releaseResource(row("pull-request", "acme/api#1"), [])).rejects.toThrow(
    "jigs does not release pull-request resources",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("ancestry counts commits the default branch lacks, and answers null without one", async () => {
  runWorktree("feat");
  expect(await countUnmergedCommits(repoDir, "feat")).toBe(1);
  merge("feat");
  expect(await countUnmergedCommits(repoDir, "feat")).toBe(0);
  git(repoDir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  expect(await countUnmergedCommits(repoDir, "feat")).toBeNull();
});

test("a missing directory is not assumed clean", async () => {
  expect(await isWorktreeDirty(path.join(tmp, "nowhere"))).toBe(true);
});
