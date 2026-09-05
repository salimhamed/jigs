import type { WorktreeFacts } from "jigs";
import { WorktreeOwnedError } from "jigs";
import { afterAll, expect, test } from "vitest";
import { acquireWorktree } from "./acquire";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
} from "./registry";

// Two transactions run concurrently, so the pool needs two connections.
const sql = connectRegistry(
  process.env.WORKFLOW_POSTGRES_URL ??
    "postgres://jigs:jigs@localhost:5439/jigs",
  { max: 2 },
);

const testPath = `/tmp/jigs-acquire-live/${crypto.randomUUID()}`;

afterAll(async () => {
  await sql`DELETE FROM jigs_worktrees WHERE path = ${testPath}`;
  await sql.end();
});

function factsFor(branch: string): WorktreeFacts {
  return {
    path: testPath,
    branch,
    resolution: "new",
    defaultBranch: "main",
    baseSha: "base1",
    headSha: "base1",
    behindDefault: 0,
  };
}

test("concurrent acquires of one unowned path: the loser sees the winner's ownership", async () => {
  await ensureWorktreeRegistry(sql);

  let releaseWinner: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });

  const request = (runId: string) => ({
    runId,
    repoDir: "/data/bindings/acme-abc12345/api/repo.git",
    worktreePath: testPath,
    branch: "feat",
  });
  const runIsLive = async (runId: string) => runId === "run_winner";

  // The winner holds the advisory lock across a slow worktreeStatus — the
  // window the unlocked implementation lost ownership in.
  const winner = acquireWorktree(request("run_winner"), {
    sql,
    runIsLive,
    worktreeStatus: async () => {
      await gate;
      return null;
    },
    createWorktree: async () => factsFor("feat"),
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const loser = acquireWorktree(request("run_loser"), {
    sql,
    runIsLive,
    worktreeStatus: async () => null,
    createWorktree: async () => {
      throw new Error("the loser must never create over the winner's worktree");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseWinner();

  await expect(winner).resolves.toMatchObject({ headSha: "base1" });
  await expect(loser).rejects.toThrow(WorktreeOwnedError);
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_winner");
});
