import type {
  CreateWorktreeOptions,
  WorktreeFacts,
  WorktreeStatus,
} from "jigs";
import { WorktreeOwnedError } from "jigs";
import type { Sql } from "postgres";
import { expect, test } from "vitest";
import { acquireWorktree } from "./acquire";
import type { WorktreeRow } from "./registry";

// Fakes the postgres tagged-template client: registry SELECTs read the store
// keyed by the interpolated path, INSERT ... ON CONFLICT writes it back, and
// anything else (the advisory-lock SELECT) falls through to an empty array.
function makeFakeSql(store: Map<string, WorktreeRow>): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$");
    if (query.includes("FROM jigs_worktrees")) {
      const row = store.get(values[0] as string);
      return Promise.resolve(row === undefined ? [] : [row]);
    }
    if (query.trimStart().startsWith("INSERT")) {
      const [path, branch, ownerRunId, state, baseSha, headSha, behind] =
        values as [string, string, string, string, string, string, number];
      store.set(path, {
        path,
        branch,
        ownerRunId,
        state,
        baseSha,
        headSha,
        behindDefault: behind,
      });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  sql.begin = (fn: (sql: unknown) => unknown) => Promise.resolve(fn(sql));
  return sql as unknown as Sql;
}

const request = {
  runId: "run_new",
  checkoutRoot: "/repos/api",
  worktreePath: "/data/worktrees/acme-abc12345/api/feat",
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
      checkoutRoot: request.checkoutRoot,
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
