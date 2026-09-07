import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { provisionRunWorktree } from "./index.ts";
import { bindingDir, worktreePath } from "./layout.ts";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
  upsertWorktree,
} from "./registry.ts";
import {
  git,
  makeClonedBinding,
  makeTmpDir,
  removeTmpDir,
} from "./test-fixtures.ts";

const sql = connectRegistry(
  process.env.WORKFLOW_POSTGRES_URL ??
    "postgres://jigs:jigs@localhost:5439/jigs",
  { max: 1 },
);

// A throwaway factory root keys a worktree path no other run of this test
// shares; everything below it — the clone, the cut, the provisioning — is
// real, so what the registry answers is the only thing under test.
const tmp = makeTmpDir();
const factoryRoot = path.join(tmp, "factory");
mkdirSync(factoryRoot, { recursive: true });
vi.stubEnv("JIGS_FACTORY_ROOT", factoryRoot);
vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));

const dirs = { factoryRoot, bindingName: "api" };
const { repoDir, remoteDir } = makeClonedBinding(tmp, bindingDir(dirs));
const testPath = worktreePath({ ...dirs, branch: "feat" });
writeFileSync(
  path.join(factoryRoot, "jigs.yml"),
  `bindings:\n  api:\n    remote: ${remoteDir}\nservice:\n  port: 8990\n  dashboard_port: 9090\n`,
);

afterAll(async () => {
  await sql`DELETE FROM jigs_worktrees WHERE path = ${testPath}`;
  await sql.end();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const request = { binding: "api", branch: "feat" };

test("a relaunched ticket adopts the leftover worktree and takes over its row", async () => {
  await ensureWorktreeRegistry(sql);

  const first = await provisionRunWorktree(request, "run_first", { sql });
  expect(first).toMatchObject({ path: testPath });
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_first");
  const head = git(testPath, "rev-parse", "HEAD");

  const second = await provisionRunWorktree(request, "run_second", {
    sql,
    readOwner: async () => ({ terminal: true, status: "completed" }),
  });
  // Adopted, not re-cut: the tree the first run left is still the one here.
  expect(second).toMatchObject({ path: testPath });
  expect(git(testPath, "rev-parse", "HEAD")).toBe(head);
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
      sql,
      readOwner: async () => ({ terminal: false, status: "running" }),
    }),
  ).rejects.toThrow(/run_live/);
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_live");
});
