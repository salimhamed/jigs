import { expect, test, vi } from "vitest";
import { JigsError } from "../errors.ts";
import type { Worktree } from "../workspaces/worktree.ts";
import { type BranchState, bindGitSteps } from "./committed-work.ts";

const worktree: Worktree = {
  binding: "app",
  path: "/tmp/wt",
  branch: "acme/abc-1",
  defaultBranch: "main",
  baseSha: "base000",
};

function bound(state: BranchState) {
  const readBranchState = vi.fn(async () => state);
  return { readBranchState, ...bindGitSteps({ readBranchState }) };
}

async function failure(promise: Promise<unknown>): Promise<JigsError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(JigsError);
  return error as JigsError;
}

test("returns the branch state when there is a new commit and no uncommitted change", async () => {
  const state = { commits: 2, headSha: "h1", dirty: false };
  const { committedWork, readBranchState } = bound(state);

  await expect(committedWork(worktree)).resolves.toEqual(state);
  expect(readBranchState).toHaveBeenCalledWith(worktree, "base000");
});

test("a dirty tree fails with a hint to inspect the worktree", async () => {
  const { committedWork } = bound({ commits: 1, headSha: "h1", dirty: true });

  const error = await failure(committedWork(worktree));

  expect(error.message).toBe("the agent left uncommitted changes in /tmp/wt");
  expect(error.hint).toBe(
    "inspect the worktree, then commit or discard them: git -C /tmp/wt status",
  );
});

test("no commit since the base fails", async () => {
  const { committedWork } = bound({ commits: 0, headSha: "base000", dirty: false });

  const error = await failure(committedWork(worktree));

  expect(error.message).toBe("the agent committed nothing on acme/abc-1");
  expect(error.hint).toContain("agent's output");
});

test("since counts from the given commit and fails when nothing is new", async () => {
  const { committedWork, readBranchState } = bound({ commits: 0, headSha: "h1", dirty: false });

  const error = await failure(committedWork(worktree, { since: "0123456789abcdef" }));

  expect(readBranchState).toHaveBeenCalledWith(worktree, "0123456789abcdef");
  expect(error.message).toBe("the agent added no commit on acme/abc-1 since 0123456");
});
