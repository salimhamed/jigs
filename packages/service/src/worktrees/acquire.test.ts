import type {
  CreateWorktreeOptions,
  WorktreeFacts,
  WorktreeStatus,
} from "jigs";
import { WorktreeOwnedError } from "jigs";
import { expect, test } from "vitest";
import { acquireWorktree } from "./acquire";
import type { WorktreeRow } from "./registry";
import { makeFakeSql } from "./test-fixtures";

const request = {
  runId: "run_new",
  repoDir: "/data/bindings/acme-abc12345/api/repo.git",
  worktreePath: "/data/bindings/acme-abc12345/api/worktrees/feat",
  branch: "feat",
};

const cleanDisk: WorktreeStatus = {
  branchMatches: true,
  clean: true,
  diverged: false,
  headSha: "head1",
  behindDefault: 2,
  defaultBranch: "main",
  baseSha: "base1",
};

function registeredRow(ownerRunId: string): WorktreeRow {
  return {
    path: request.worktreePath,
    branch: "feat",
    ownerRunId,
    state: "active",
    baseSha: "base0",
    headSha: "head0",
    behindDefault: 0,
    repoDir: "/data/bindings/acme-abc12345/api/repo.git",
    keep: false,
  };
}

const createdFacts: WorktreeFacts = {
  path: request.worktreePath,
  branch: "feat",
  resolution: "new",
  defaultBranch: "main",
  baseSha: "base2",
  headSha: "base2",
  behindDefault: 0,
};

test("a worktree registered to a live run is refused, naming the owner", async () => {
  const store = new Map([[request.worktreePath, registeredRow("run_owner")]]);
  await expect(
    acquireWorktree(request, {
      sql: makeFakeSql(store),
      runIsLive: async () => true,
      worktreeStatus: async () => cleanDisk,
    }),
  ).rejects.toThrow(WorktreeOwnedError);
  expect(store.get(request.worktreePath)?.ownerRunId).toBe("run_owner");
});

test("a live foreign owner is refused before disk is ever inspected", async () => {
  const store = new Map([[request.worktreePath, registeredRow("run_owner")]]);
  await expect(
    acquireWorktree(request, {
      sql: makeFakeSql(store),
      runIsLive: async () => true,
      worktreeStatus: async () => {
        throw new Error("worktreeStatus must not run for an owned worktree");
      },
    }),
  ).rejects.toThrow(WorktreeOwnedError);
});

test("a terminal owner's clean worktree is reused and re-owned", async () => {
  const store = new Map([[request.worktreePath, registeredRow("run_done")]]);
  const facts = await acquireWorktree(request, {
    sql: makeFakeSql(store),
    runIsLive: async () => false,
    worktreeStatus: async () => cleanDisk,
  });
  expect(facts.headSha).toBe("head1");
  expect(store.get(request.worktreePath)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
    headSha: "head1",
    baseSha: "base1",
    behindDefault: 2,
  });
});

test("no worktree on disk creates one and registers the requesting run", async () => {
  const store = new Map<string, WorktreeRow>();
  const createCalls: CreateWorktreeOptions[] = [];
  const facts = await acquireWorktree(request, {
    sql: makeFakeSql(store),
    runIsLive: async () => false,
    worktreeStatus: async () => null,
    createWorktree: async (options) => {
      createCalls.push(options);
      return createdFacts;
    },
  });
  expect(facts).toEqual(createdFacts);
  expect(createCalls).toEqual([
    {
      repoDir: request.repoDir,
      worktreePath: request.worktreePath,
      branch: request.branch,
    },
  ]);
  expect(store.get(request.worktreePath)).toMatchObject({
    ownerRunId: "run_new",
    state: "active",
    baseSha: "base2",
  });
});
