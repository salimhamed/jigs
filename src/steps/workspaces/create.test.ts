import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorktree, findWorktree } from "./create.ts";
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
  removeTmpDir(tmp);
});

function wtPath(name: string): string {
  return path.join(worktreesDir, name);
}

const localBranches = () => git(repoDir, "for-each-ref", "--format=%(refname)", "refs/heads");

// A worktree removed mid-run leaves its branch holding the run's commits.
async function branchWithWorkButNoWorktree(name: string): Promise<string> {
  const wt = wtPath(name);
  await createWorktree({ repoDir, worktreePath: wt, branch: `agent/${name}` });
  writeFileSync(path.join(wt, "work.txt"), "work\n");
  git(wt, "add", "work.txt");
  git(wt, "commit", "-q", "-m", "work");
  const work = git(wt, "rev-parse", "HEAD");
  git(repoDir, "worktree", "remove", "--force", wt);
  commitToRemote(tmp, remoteDir, "main", { "b.txt": "newer" });
  return work;
}

test("a branch holding work but no worktree is checked out as-is", async () => {
  const work = await branchWithWorkButNoWorktree("kept");

  await createWorktree({ repoDir, worktreePath: wtPath("kept"), branch: "agent/kept" });

  expect(git(wtPath("kept"), "rev-parse", "HEAD")).toBe(work);
  expect(git(repoDir, "rev-parse", "refs/heads/agent/kept")).toBe(work);
});

test("a path holding something else is refused, naming it, and no branch moves", async () => {
  const work = await branchWithWorkButNoWorktree("taken");
  await createWorktree({ repoDir, worktreePath: wtPath("taken"), branch: "agent/other" });

  await expect(
    createWorktree({ repoDir, worktreePath: wtPath("taken"), branch: "agent/taken" }),
  ).rejects.toThrow(`${wtPath("taken")} exists but is not a worktree on agent/taken`);
  expect(git(repoDir, "rev-parse", "refs/heads/agent/taken")).toBe(work);
});

test("a new branch forks from origin default, not a stale local one", async () => {
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

test("findWorktree reports a missing directory as null", async () => {
  const found = await findWorktree({
    repoDir,
    worktreePath: wtPath("never-made"),
    branch: "feat",
  });
  expect(found).toBeNull();
});

test("findWorktree sees a worktree through a symlinked parent directory", async () => {
  await createWorktree({
    repoDir,
    worktreePath: wtPath("linked"),
    branch: "agent/linked",
  });
  const linkedParent = path.join(tmp, "worktrees-link");
  symlinkSync(worktreesDir, linkedParent);

  const found = await findWorktree({
    repoDir,
    worktreePath: path.join(linkedParent, "linked"),
    branch: "agent/linked",
  });
  expect(found?.branch).toBe("agent/linked");
});

test("findWorktree ignores a worktree on another branch", async () => {
  await createWorktree({
    repoDir,
    worktreePath: wtPath("other"),
    branch: "agent/other",
  });
  const found = await findWorktree({
    repoDir,
    worktreePath: wtPath("other"),
    branch: "agent/mine",
  });
  expect(found).toBeNull();
});
