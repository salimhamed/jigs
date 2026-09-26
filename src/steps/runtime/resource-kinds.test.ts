import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { countUnmergedCommits, isWorktreeDirty } from "../workspaces/teardown.ts";
import { git, makeClonedBinding } from "../workspaces/test-fixtures.ts";
import type { ResourceRow } from "./registry.ts";
import { releaseRefusal, releaseResource } from "./resource-kinds.ts";

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

  expect(await releaseRefusal(tree, [])).toBe("uncommitted work kept");
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

test("a worktree record jigs did not provision is never deleted", async () => {
  const tree = runWorktree("feat");

  expect(await releaseResource({ ...tree, repoDir: null, branch: null }, [])).toEqual({
    state: "kept",
    reason: "not provisioned by jigs",
  });
  expect(existsSync(tree.identity)).toBe(true);
});

test("a git failure during removal is recorded as failed, and the tree stays", async () => {
  const tree = runWorktree("feat");
  git(repoDir, "worktree", "lock", tree.identity);

  const outcome = await releaseResource(tree, []);

  expect(outcome.state).toBe("failed");
  expect(outcome.reason).toMatch(/^release failed: /);
  expect(existsSync(tree.identity)).toBe(true);
});

test("harness homes stay while any worktree of the run is not released", async () => {
  const home = row("codex-home", "wrun_1");
  expect(await releaseRefusal(home, [{ kind: "worktree", state: "kept" }])).toBe(
    "kept with the run's worktree",
  );
  expect(await releaseRefusal(home, [{ kind: "worktree", state: "released" }])).toBeNull();
});

test("recorded-only kinds are never dispatched", async () => {
  expect(await releaseResource(row("pull-request", "acme/api#1"), [])).toEqual({
    state: "kept",
    reason: "recorded only",
  });
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

// ---- GitHub branches ---------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const branch = row("branch", "acme/api:feature/x");

function github(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace("http://mock.test/github", "")}`;
    const route = Object.entries(routes).find(([prefix]) => key.startsWith(prefix));
    if (route === undefined) throw new Error(`unexpected GitHub call ${key}`);
    return route[1]();
  });
}

const HEAD = "GET /repos/acme/api/git/ref/heads/feature/x";
const PULLS = "GET /repos/acme/api/pulls?state=all&head=acme%3Afeature%2Fx";
const DELETE = "DELETE /repos/acme/api/git/refs/heads/feature/x";

test("a branch with an open pull request is kept, naming it", async () => {
  github({
    [HEAD]: () => json({ object: { sha: "abc" } }),
    [PULLS]: () =>
      json([{ number: 7, state: "open", merged_at: null, head: { ref: "feature/x", sha: "abc" } }]),
  });

  expect(await releaseResource(branch, [])).toEqual({
    state: "kept",
    reason: "pull request #7 is still open",
  });
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
});

test("a branch whose pull request merged at its head is deleted on GitHub", async () => {
  github({
    [HEAD]: () => json({ object: { sha: "abc" } }),
    [PULLS]: () =>
      json([
        {
          number: 7,
          state: "closed",
          merged_at: "2026-09-25",
          head: { ref: "feature/x", sha: "abc" },
        },
      ]),
    [DELETE]: () => new Response(null, { status: 204 }),
  });

  expect(await releaseResource(branch, [])).toEqual({
    state: "released",
    reason: "deleted on GitHub",
  });
});

test("a branch with commits the default branch lacks is kept", async () => {
  github({
    [HEAD]: () => json({ object: { sha: "abc" } }),
    [PULLS]: () => json([]),
    "GET /repos/acme/api/compare/main...abc": () => json({ ahead_by: 2 }),
    "GET /repos/acme/api": () => json({ default_branch: "main" }),
  });

  expect(await releaseResource(branch, [])).toEqual({
    state: "kept",
    reason: "2 commit(s) are not on main",
  });
});

test("a branch contained in the default branch is deleted", async () => {
  github({
    [HEAD]: () => json({ object: { sha: "abc" } }),
    [PULLS]: () => json([]),
    "GET /repos/acme/api/compare/main...abc": () => json({ ahead_by: 0 }),
    "GET /repos/acme/api": () => json({ default_branch: "main" }),
    [DELETE]: () => new Response(null, { status: 204 }),
  });

  expect((await releaseResource(branch, [])).state).toBe("released");
});

test("a branch already deleted on GitHub is released", async () => {
  github({
    [HEAD]: () => json({ message: "Not Found" }, 404),
    [DELETE]: () => json({ message: "Reference does not exist" }, 422),
  });

  expect(await releaseResource(branch, [])).toEqual({
    state: "released",
    reason: "already absent on GitHub",
  });
});

test("a GitHub outage is a failed release, never a deletion", async () => {
  github({ [HEAD]: () => json({ message: "boom" }, 502) });

  expect((await releaseResource(branch, [])).state).toBe("failed");
});
