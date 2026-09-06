import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Binding,
  bindingRepoDir,
  type WorktreeFacts,
  worktreePath,
} from "@salimhamed/jigs";
import { afterAll, expect, test, vi } from "vitest";
import { provisionRunWorktree } from "./index";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
} from "./registry";
import { WorktreeOwnedError } from "./reuse";

// Two transactions run concurrently, so the pool needs two connections.
const sql = connectRegistry(
  process.env.WORKFLOW_POSTGRES_URL ??
    "postgres://jigs:jigs@localhost:5439/jigs",
  { max: 2 },
);

// A throwaway factory root keys a worktree path no other run of this test
// shares, and its clone marker is all the request path asserts about the clone.
const tmp = mkdtempSync(path.join(tmpdir(), "jigs-worktrees-live-"));
vi.stubEnv("JIGS_FACTORY_ROOT", tmp);
vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
const dirs = { factoryRoot: tmp, bindingName: "api" };
const repoDir = bindingRepoDir(dirs);
const testPath = worktreePath({ ...dirs, branch: "feat" });
mkdirSync(path.join(repoDir, "refs", "remotes", "origin"), { recursive: true });
writeFileSync(
  path.join(repoDir, "refs", "remotes", "origin", "HEAD"),
  "ref: refs/remotes/origin/main\n",
);

const binding: Binding = {
  name: "api",
  remote: "git@github.com:acme/api.git",
  copy: [],
  post_create: [],
  hook_timeout_minutes: 20,
};

afterAll(async () => {
  await sql`DELETE FROM jigs_worktrees WHERE path = ${testPath}`;
  await sql.end();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function factsFor(branch: string): WorktreeFacts {
  return {
    path: testPath,
    branch,
    defaultBranch: "main",
    baseSha: "base1",
  };
}

test("concurrent requests for one unowned path: the loser sees the winner's ownership", async () => {
  await ensureWorktreeRegistry(sql);

  let releaseWinner: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });

  const request = { binding: "api", branch: "feat" };
  const shared = {
    sql,
    resolveBinding: () => binding,
    runIsLive: async (runId: string) => runId === "run_winner",
    provision: async () => {},
    log: () => {},
  };

  // The winner holds the advisory lock across a slow worktreeStatus — the
  // window the unlocked implementation lost ownership in.
  const winner = provisionRunWorktree(request, "run_winner", {
    ...shared,
    worktreeStatus: async () => {
      await gate;
      return null;
    },
    createWorktree: async () => factsFor("feat"),
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const loser = provisionRunWorktree(request, "run_loser", {
    ...shared,
    worktreeStatus: async () => null,
    createWorktree: async () => {
      throw new Error("the loser must never create over the winner's worktree");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseWinner();

  await expect(winner).resolves.toMatchObject({ baseSha: "base1" });
  await expect(loser).rejects.toThrow(WorktreeOwnedError);
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_winner");
});
