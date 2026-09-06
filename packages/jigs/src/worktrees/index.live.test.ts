import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import type { Binding } from "../config/factory-config.ts";
import type { WorktreeFacts } from "./facts.ts";
import { provisionRunWorktree } from "./index.ts";
import { bindingRepoDir, worktreePath } from "./layout.ts";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
  upsertWorktree,
} from "./registry.ts";

const sql = connectRegistry(
  process.env.WORKFLOW_POSTGRES_URL ??
    "postgres://jigs:jigs@localhost:5439/jigs",
  { max: 1 },
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

const request = { binding: "api", branch: "feat" };
const shared = {
  sql,
  resolveBinding: () => binding,
  runIsLive: async () => false,
  provision: async () => {},
  log: () => {},
};

test("a relaunched ticket adopts the leftover worktree and takes over its row", async () => {
  await ensureWorktreeRegistry(sql);

  const first = await provisionRunWorktree(request, "run_first", {
    ...shared,
    worktreeStatus: async () => null,
    createWorktree: async () => factsFor("feat"),
  });
  expect(first).toMatchObject({ path: testPath, baseSha: "base1" });
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_first");

  const second = await provisionRunWorktree(request, "run_second", {
    ...shared,
    worktreeStatus: async () => ({
      branchMatches: true,
      clean: true,
      diverged: false,
      defaultBranch: "main",
      baseSha: "base1",
    }),
    createWorktree: async () => {
      throw new Error("a reusable worktree must not be cut again");
    },
  });
  expect(second).toMatchObject({ path: testPath, baseSha: "base1" });
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_second");
});

test("a live owner read back from the registry refuses the second run by name", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, {
    path: testPath,
    branch: "feat",
    ownerRunId: "run_live",
    state: "active",
    repoDir,
  });

  await expect(
    provisionRunWorktree(request, "run_other", {
      ...shared,
      runIsLive: async () => true,
      worktreeStatus: async () => {
        throw new Error("a live owner must be refused before disk is read");
      },
      createWorktree: async () => factsFor("feat"),
    }),
  ).rejects.toThrow(/run_live/);
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_live");
});
