import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createWorktree, worktreeStatus } from "./create.ts";
import {
  commitToRemote,
  git,
  makeClonedBinding,
  makeTmpDir,
  removeTmpDir,
} from "./test-fixtures.ts";

let tmp: string;
let repoDir: string;
let remoteDir: string;
let worktreesDir: string;

beforeEach(() => {
  tmp = makeTmpDir();
  ({ repoDir, remoteDir, worktreesDir } = makeClonedBinding(tmp));
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

function wtPath(name: string): string {
  return path.join(worktreesDir, name);
}

const localBranches = () => git(repoDir, "for-each-ref", "--format=%(refname)", "refs/heads");

test("existing local branch is checked out as-is and never reset", async () => {
  const shaA = git(repoDir, "rev-parse", "refs/remotes/origin/main");
  git(repoDir, "branch", "feat", shaA);
  const shaB = commitToRemote(tmp, remoteDir, "feat", { "b.txt": "remote" });
  expect(shaB).not.toBe(shaA);

  const facts = await createWorktree({
    repoDir,
    worktreePath: wtPath("feat"),
    branch: "feat",
  });
  expect(facts.baseSha).toBe(shaA);
  expect(git(wtPath("feat"), "rev-parse", "HEAD")).toBe(shaA);
});

test("remote-only branch is tracked", async () => {
  const remoteSha = commitToRemote(tmp, remoteDir, "feat", { "b.txt": "1" });

  await createWorktree({
    repoDir,
    worktreePath: wtPath("feat"),
    branch: "feat",
  });
  expect(git(wtPath("feat"), "rev-parse", "HEAD")).toBe(remoteSha);
  expect(git(repoDir, "rev-parse", "--abbrev-ref", "feat@{upstream}")).toBe("origin/feat");
});

test("unknown branch forks from origin default, not a stale local one", async () => {
  // A leftover refs/heads/main from an earlier life of this clone: nothing
  // fast-forwards it any more, so it must never be the fork point.
  const staleLocalMain = git(repoDir, "rev-parse", "refs/remotes/origin/main");
  git(repoDir, "update-ref", "refs/heads/main", staleLocalMain);
  const advancedRemoteMain = commitToRemote(tmp, remoteDir, "main", {
    "c.txt": "newer",
  });
  expect(advancedRemoteMain).not.toBe(staleLocalMain);

  const facts = await createWorktree({
    repoDir,
    worktreePath: wtPath("fresh"),
    branch: "agent/fresh",
  });
  expect(facts.baseSha).toBe(advancedRemoteMain);
  expect(git(wtPath("fresh"), "rev-parse", "HEAD")).toBe(advancedRemoteMain);
});

test("a branch the remote deleted on merge forks fresh, not off its stale tracking ref", async () => {
  // The merged run's lineage, still in the clone as refs/remotes/origin/<b>
  // after GitHub's delete-on-merge: forking from it re-presents commits that
  // are already in the default branch.
  const preSquash = commitToRemote(tmp, remoteDir, "agent/merged", {
    "old.txt": "pre-squash",
  });
  git(repoDir, "fetch", "-q", "origin");
  expect(git(repoDir, "rev-parse", "refs/remotes/origin/agent/merged")).toBe(preSquash);
  git(remoteDir, "update-ref", "-d", "refs/heads/agent/merged");

  await createWorktree({
    repoDir,
    worktreePath: wtPath("merged"),
    branch: "agent/merged",
  });
  expect(git(wtPath("merged"), "rev-parse", "HEAD")).toBe(
    git(repoDir, "rev-parse", "refs/remotes/origin/main"),
  );
  expect(() => git(repoDir, "rev-parse", "refs/remotes/origin/agent/merged")).toThrow();
});

test("the deleted-branch case survives an operator locale that translates git", async () => {
  // The missing-ref check reads git's message, which gettext translates: the
  // guard is LC_ALL=C in the git env, not the developer's own locale.
  vi.stubEnv("LANGUAGE", "de");
  commitToRemote(tmp, remoteDir, "agent/localized", { "old.txt": "pre" });
  git(repoDir, "fetch", "-q", "origin");
  git(remoteDir, "update-ref", "-d", "refs/heads/agent/localized");

  await createWorktree({
    repoDir,
    worktreePath: wtPath("localized"),
    branch: "agent/localized",
  });
  expect(git(wtPath("localized"), "rev-parse", "HEAD")).toBe(
    git(repoDir, "rev-parse", "refs/remotes/origin/main"),
  );
});

test("worktree creation never writes refs/heads/<default>", async () => {
  const advancedRemoteMain = commitToRemote(tmp, remoteDir, "main", {
    "d.txt": "advance",
  });

  const facts = await createWorktree({
    repoDir,
    worktreePath: wtPath("untouched"),
    branch: "agent/untouched",
  });
  expect(localBranches().split("\n")).toEqual(["refs/heads/agent/untouched"]);
  expect(facts.baseSha).toBe(advancedRemoteMain);
});

test("git operations survive the orchestrator's cwd being a removed worktree", async () => {
  const first = wtPath("one");
  await createWorktree({
    repoDir,
    worktreePath: first,
    branch: "agent/one",
  });
  const originalCwd = process.cwd();
  try {
    process.chdir(first);
    rmSync(first, { recursive: true, force: true });
    git(repoDir, "worktree", "prune");

    await createWorktree({
      repoDir,
      worktreePath: wtPath("two"),
      branch: "agent/two",
    });
    expect(git(wtPath("two"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/two");
  } finally {
    process.chdir(originalCwd);
  }
});

test("a worktree deleted without pruning can be recreated at the same path", async () => {
  const wt = wtPath("reborn");
  await createWorktree({
    repoDir,
    worktreePath: wt,
    branch: "agent/reborn",
  });
  rmSync(wt, { recursive: true, force: true });

  await createWorktree({
    repoDir,
    worktreePath: wt,
    branch: "agent/reborn",
  });
  expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/reborn");
  expect(localBranches().split("\n")).toEqual(["refs/heads/agent/reborn"]);
});

test("worktreeStatus reports a missing directory as null", async () => {
  const status = await worktreeStatus({
    repoDir,
    worktreePath: wtPath("never-made"),
    branch: "feat",
  });
  expect(status).toBeNull();
});

test("worktreeStatus sees a worktree through a symlinked parent directory", async () => {
  await createWorktree({
    repoDir,
    worktreePath: wtPath("linked"),
    branch: "agent/linked",
  });
  const linkedParent = path.join(tmp, "worktrees-link");
  symlinkSync(worktreesDir, linkedParent);

  const status = await worktreeStatus({
    repoDir,
    worktreePath: path.join(linkedParent, "linked"),
    branch: "agent/linked",
  });
  expect(status).not.toBeNull();
  expect(status?.branchMatches).toBe(true);
});

test("worktreeStatus flags an untracked file as dirty", async () => {
  const wt = wtPath("dirty");
  await createWorktree({
    repoDir,
    worktreePath: wt,
    branch: "agent/dirty",
  });
  writeFileSync(path.join(wt, "scratch.txt"), "wip");

  const status = await worktreeStatus({
    repoDir,
    worktreePath: wt,
    branch: "agent/dirty",
  });
  expect(status).not.toBeNull();
  expect(status?.branchMatches).toBe(true);
  expect(status?.clean).toBe(false);
  expect(status?.diverged).toBe(false);
});

test("worktreeStatus flags divergence when local and origin both advanced", async () => {
  const wt = wtPath("split");
  await createWorktree({
    repoDir,
    worktreePath: wt,
    branch: "agent/split",
  });
  git(wt, "push", "-q", "-u", "origin", "agent/split");
  writeFileSync(path.join(wt, "local.txt"), "local");
  git(wt, "add", "local.txt");
  git(wt, "commit", "-q", "-m", "local work");
  commitToRemote(tmp, remoteDir, "agent/split", { "remote.txt": "remote" });

  const status = await worktreeStatus({
    repoDir,
    worktreePath: wt,
    branch: "agent/split",
  });
  expect(status?.clean).toBe(true);
  expect(status?.diverged).toBe(true);
});

test("worktreeStatus treats behind-only as ff-safe, not diverged", async () => {
  const wt = wtPath("behind");
  await createWorktree({
    repoDir,
    worktreePath: wt,
    branch: "agent/behind",
  });
  git(wt, "push", "-q", "-u", "origin", "agent/behind");
  commitToRemote(tmp, remoteDir, "agent/behind", { "more.txt": "ahead" });

  const status = await worktreeStatus({
    repoDir,
    worktreePath: wt,
    branch: "agent/behind",
  });
  expect(status).not.toBeNull();
  expect(status?.clean).toBe(true);
  expect(status?.diverged).toBe(false);
});
