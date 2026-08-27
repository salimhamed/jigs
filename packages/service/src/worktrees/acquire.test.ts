import type {
  CreateWorktreeOptions,
  WorktreeFacts,
  WorktreeStatus,
} from "jigs";
import { WorktreeOwnedError } from "jigs";
import type { Sql } from "postgres";
import { expect, test } from "vitest";
import { acquireWorktree } from "./acquire";

interface DbRow {
  path: string;
  branch: string;
  owner_run_id: string;
  state: string;
  base_sha: string;
  head_sha: string;
  behind_default: number;
}

// Fakes the postgres tagged-template client: SELECTs read the store keyed by
// the interpolated path, INSERT ... ON CONFLICT writes it back.
function makeFakeSql(store: Map<string, DbRow>): Sql {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$");
    if (query.trimStart().startsWith("SELECT")) {
      const row = store.get(values[0] as string);
      return Promise.resolve(row === undefined ? [] : [row]);
    }
    if (query.trimStart().startsWith("INSERT")) {
      const [path, branch, ownerRunId, state, baseSha, headSha, behind] =
        values as [string, string, string, string, string, string, number];
      store.set(path, {
        path,
        branch,
        owner_run_id: ownerRunId,
        state,
        base_sha: baseSha,
        head_sha: headSha,
        behind_default: behind,
      });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}

const request = {
  runId: "run_new",
  checkoutRoot: "/repos/api",
  worktreePath: "/data/worktrees/acme-abc12345/api/feat",
  branch: "feat",
};

const cleanDisk: WorktreeStatus = {
  exists: true,
  branchMatches: true,
  clean: true,
  diverged: false,
  headSha: "head1",
  behindDefault: 2,
  defaultBranch: "main",
  baseSha: "base1",
};

const missingDisk: WorktreeStatus = {
  exists: false,
  branchMatches: false,
  clean: false,
  diverged: false,
  headSha: null,
  behindDefault: null,
  defaultBranch: null,
  baseSha: null,
};

function registeredRow(ownerRunId: string): DbRow {
  return {
    path: request.worktreePath,
    branch: "feat",
    owner_run_id: ownerRunId,
    state: "active",
    base_sha: "base0",
    head_sha: "head0",
    behind_default: 0,
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
  expect(store.get(request.worktreePath)?.owner_run_id).toBe("run_owner");
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
    owner_run_id: "run_new",
    state: "active",
    head_sha: "head1",
    base_sha: "base1",
    behind_default: 2,
  });
});

test("no worktree on disk creates one and registers the requesting run", async () => {
  const store = new Map<string, DbRow>();
  const createCalls: CreateWorktreeOptions[] = [];
  const facts = await acquireWorktree(request, {
    sql: makeFakeSql(store),
    runIsLive: async () => false,
    worktreeStatus: async () => missingDisk,
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
    owner_run_id: "run_new",
    state: "active",
    base_sha: "base2",
  });
});
