import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  commitToRemote,
  git,
  makeRemoteBackedRepo,
  makeTmpDir,
  removeTmpDir,
} from "../test-fixtures.ts";
import { createWorktree, worktreeStatus } from "./create.ts";

let tmp: string;
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => {
  removeTmpDir(tmp);
});

function wtPath(name: string): string {
  return path.join(tmp, "worktrees", name);
}

test("existing local branch is checked out as-is and never reset", async () => {
  const { checkout, remoteDir } = makeRemoteBackedRepo(tmp);
  const shaA = git(checkout, "rev-parse", "HEAD");
  git(checkout, "branch", "feat");
  const shaB = commitToRemote(tmp, remoteDir, "feat", { "b.txt": "remote" });
  expect(shaB).not.toBe(shaA);

  const facts = await createWorktree({
    checkoutRoot: checkout,
    worktreePath: wtPath("feat"),
    branch: "feat",
  });
  expect(facts.resolution).toBe("local");
  expect(facts.headSha).toBe(shaA);
  expect(git(wtPath("feat"), "rev-parse", "HEAD")).toBe(shaA);
});

test("remote-only branch is tracked", async () => {
  const { checkout, remoteDir } = makeRemoteBackedRepo(tmp);
  const remoteSha = commitToRemote(tmp, remoteDir, "feat", { "b.txt": "1" });

  const facts = await createWorktree({
    checkoutRoot: checkout,
    worktreePath: wtPath("feat"),
    branch: "feat",
  });
  expect(facts.resolution).toBe("remote");
  expect(facts.headSha).toBe(remoteSha);
  expect(git(checkout, "rev-parse", "--abbrev-ref", "feat@{upstream}")).toBe(
    "origin/feat",
  );
});

test("unknown branch forks from origin default, not the stale local one", async () => {
  const { checkout, remoteDir } = makeRemoteBackedRepo(tmp);
  const staleLocalMain = git(checkout, "rev-parse", "refs/heads/main");
  const advancedRemoteMain = commitToRemote(tmp, remoteDir, "main", {
    "c.txt": "newer",
  });
  expect(advancedRemoteMain).not.toBe(staleLocalMain);

  const facts = await createWorktree({
    checkoutRoot: checkout,
    worktreePath: wtPath("fresh"),
    branch: "agent/fresh",
  });
  expect(facts.resolution).toBe("new");
  expect(facts.baseSha).toBe(advancedRemoteMain);
  expect(facts.headSha).toBe(advancedRemoteMain);
  expect(facts.behindDefault).toBe(0);
});

test("worktree creation leaves the local default branch alone", async () => {
  const { checkout, remoteDir } = makeRemoteBackedRepo(tmp);
  const mainShaBefore = git(checkout, "rev-parse", "refs/heads/main");
  const headBefore = git(checkout, "symbolic-ref", "HEAD");
  const statusBefore = git(checkout, "status", "--porcelain");
  const advancedRemoteMain = commitToRemote(tmp, remoteDir, "main", {
    "d.txt": "advance",
  });

  const facts = await createWorktree({
    checkoutRoot: checkout,
    worktreePath: wtPath("untouched"),
    branch: "agent/untouched",
  });
  expect(git(checkout, "rev-parse", "refs/heads/main")).toBe(mainShaBefore);
  expect(git(checkout, "symbolic-ref", "HEAD")).toBe(headBefore);
  expect(git(checkout, "status", "--porcelain")).toBe(statusBefore);
  expect(facts.baseSha).toBe(advancedRemoteMain);
});

test("git operations survive the orchestrator's cwd being a removed worktree", async () => {
  const { checkout } = makeRemoteBackedRepo(tmp);
  const first = wtPath("one");
  await createWorktree({
    checkoutRoot: checkout,
    worktreePath: first,
    branch: "agent/one",
  });
  const originalCwd = process.cwd();
  try {
    process.chdir(first);
    rmSync(first, { recursive: true, force: true });
    git(checkout, "worktree", "prune");

    const facts = await createWorktree({
      checkoutRoot: checkout,
      worktreePath: wtPath("two"),
      branch: "agent/two",
    });
    expect(facts.resolution).toBe("new");
  } finally {
    process.chdir(originalCwd);
  }
});

test("worktreeStatus reports a missing directory as not existing", async () => {
  const { checkout } = makeRemoteBackedRepo(tmp);
  const status = await worktreeStatus({
    checkoutRoot: checkout,
    worktreePath: wtPath("never-made"),
    branch: "feat",
  });
  expect(status.exists).toBe(false);
  expect(status.headSha).toBeNull();
});

test("worktreeStatus flags an untracked file as dirty", async () => {
  const { checkout } = makeRemoteBackedRepo(tmp);
  const wt = wtPath("dirty");
  await createWorktree({
    checkoutRoot: checkout,
    worktreePath: wt,
    branch: "agent/dirty",
  });
  writeFileSync(path.join(wt, "scratch.txt"), "wip");

  const status = await worktreeStatus({
    checkoutRoot: checkout,
    worktreePath: wt,
    branch: "agent/dirty",
  });
  expect(status.exists).toBe(true);
  expect(status.branchMatches).toBe(true);
  expect(status.clean).toBe(false);
  expect(status.diverged).toBe(false);
});

test("worktreeStatus flags divergence when local and origin both advanced", async () => {
  const { checkout, remoteDir } = makeRemoteBackedRepo(tmp);
  const wt = wtPath("split");
  await createWorktree({
    checkoutRoot: checkout,
    worktreePath: wt,
    branch: "agent/split",
  });
  git(wt, "push", "-q", "-u", "origin", "agent/split");
  writeFileSync(path.join(wt, "local.txt"), "local");
  git(wt, "add", "local.txt");
  git(wt, "commit", "-q", "-m", "local work");
  commitToRemote(tmp, remoteDir, "agent/split", { "remote.txt": "remote" });

  const status = await worktreeStatus({
    checkoutRoot: checkout,
    worktreePath: wt,
    branch: "agent/split",
  });
  expect(status.clean).toBe(true);
  expect(status.diverged).toBe(true);
});

test("worktreeStatus treats behind-only as ff-safe, not diverged", async () => {
  const { checkout, remoteDir } = makeRemoteBackedRepo(tmp);
  const wt = wtPath("behind");
  const facts = await createWorktree({
    checkoutRoot: checkout,
    worktreePath: wt,
    branch: "agent/behind",
  });
  git(wt, "push", "-q", "-u", "origin", "agent/behind");
  commitToRemote(tmp, remoteDir, "agent/behind", { "more.txt": "ahead" });

  const status = await worktreeStatus({
    checkoutRoot: checkout,
    worktreePath: wt,
    branch: "agent/behind",
  });
  expect(status.exists).toBe(true);
  expect(status.clean).toBe(true);
  expect(status.diverged).toBe(false);
  expect(status.headSha).toBe(facts.headSha);
});
