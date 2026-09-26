import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import {
  type AutomaticReleaseDeps,
  type CleanupRun,
  reconcileAutomaticRelease,
} from "../../service/automatic-release.ts";
import type { Factory } from "../../workflow/factory.ts";
import {
  CLEANUP_DIRECTIVE_ATTRIBUTE,
  CLEANUP_STATE_ATTRIBUTE,
  encodeCleanupProgress,
} from "../../workflow/runtime/cleanup.ts";
import { createRunDirectory } from "../runtime/run-directory/index.ts";
import { provisionWorktree } from "./index.ts";
import { cloneDir, worktreePath } from "./layout.ts";
import {
  connectRegistry,
  deleteWorktree,
  ensureWorktreeRegistry,
  getWorktree,
  listWorktreesForRun,
  upsertWorktree,
  withRunResourceLock,
} from "./registry.ts";
import { releaseRunResources } from "./release.ts";
import { git, makeClonedBinding, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

const sql = connectRegistry(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
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
const { repoDir, remoteDir } = makeClonedBinding(tmp, cloneDir(dirs));
const testPath = worktreePath({ ...dirs, branch: "feat" });
const dirtyPath = worktreePath({ ...dirs, branch: "automatic-dirty" });
writeFileSync(
  path.join(factoryRoot, "jigs.config.ts"),
  `export default ${JSON.stringify({ bindings: { api: { remote: remoteDir } }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} })};`,
);

afterAll(async () => {
  await deleteWorktree(sql, testPath);
  await deleteWorktree(sql, dirtyPath);
  await sql.$client.end();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

const request = { binding: "api", branch: "feat" };

test("a relaunched ticket adopts the leftover worktree and takes over its row", async () => {
  await ensureWorktreeRegistry(sql);

  const first = await provisionWorktree(request, { workflowRunId: "run_first" }, { sql });
  expect(first).toMatchObject({ path: testPath });
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_first");
  // Committed, so the tree stays clean while its HEAD moves off the default
  // branch — which is the only place a re-cut could land it.
  writeFileSync(path.join(testPath, "shipped.txt"), "shipped\n");
  git(testPath, "add", "shipped.txt");
  git(testPath, "commit", "-q", "-m", "shipped");
  const head = git(testPath, "rev-parse", "HEAD");

  const second = await provisionWorktree(
    request,
    { workflowRunId: "run_second" },
    {
      sql,
      readOwner: async () => ({ terminal: true, status: "completed" }),
    },
  );
  // Adopted, not re-cut: the work the first run left is still checked out.
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
    provisionWorktree(
      request,
      { workflowRunId: "run_other" },
      {
        sql,
        readOwner: async () => ({ terminal: false, status: "running" }),
      },
    ),
  ).rejects.toThrow(/run_live/);
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_live");
});

test("policy release keeps then removes resources through the real registry", async () => {
  const metadata = { workflowRunId: "run_release" };
  await provisionWorktree(request, metadata, {
    sql,
    readOwner: async () => ({ terminal: true, status: "completed" }),
  });
  const directory = await createRunDirectory(metadata);
  const kept = await releaseRunResources({ onSuccess: "keep", onFailure: "keep" }, metadata, sql);
  expect(kept.worktrees[0]?.removed).toBe(false);
  expect((await getWorktree(sql, testPath))?.ownerRunId).toBe("run_release");
  expect(existsSync(directory)).toBe(true);
  const released = await releaseRunResources(
    { onSuccess: "release", onFailure: "keep" },
    metadata,
    sql,
  );
  expect(released.worktrees[0]).toMatchObject({ removed: true, localBranchDeleted: false });
  expect(await getWorktree(sql, testPath)).toBeNull();
  expect(existsSync(testPath)).toBe(false);
  expect(existsSync(directory)).toBe(false);
});

test("automatic release preserves dirty work through real Postgres and Git", async () => {
  const metadata = { workflowRunId: "run_automatic_dirty" };
  await provisionWorktree({ binding: "api", branch: "automatic-dirty" }, metadata, {
    sql,
    readOwner: async () => ({ terminal: true, status: "completed" }),
  });
  writeFileSync(path.join(dirtyPath, "uncommitted.txt"), "keep me\n");
  const terminal: CleanupRun = {
    runId: metadata.workflowRunId,
    status: "completed",
    workflowName: "workflow//./workflows/ship//ship",
    attributes: {
      [CLEANUP_DIRECTIVE_ATTRIBUTE]: "automatic",
      [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({ status: "waiting" }),
    },
  };
  const deps: AutomaticReleaseDeps = {
    listRuns: async () => [terminal],
    waitForTerminal: async () => terminal,
    hasActiveStep: async () => false,
    policy: () => "release",
    withLock: (runId, action) => withRunResourceLock(sql, runId, action),
    worktreeCount: async (runId, lockedSql) => (await listWorktreesForRun(lockedSql, runId)).length,
    release: (run, action, outcome, lockedSql) =>
      releaseRunResources(
        { onSuccess: action, onFailure: action },
        { workflowRunId: run.runId },
        lockedSql,
        outcome,
      ),
    writeProgress: async (_runId, value) => {
      terminal.attributes[CLEANUP_STATE_ATTRIBUTE] = encodeCleanupProgress(value);
    },
    ready: () => true,
    log: () => undefined,
    warn: () => undefined,
    setTimer: () => () => undefined,
  };

  expect((await reconcileAutomaticRelease({ workflows: {} } as Factory, deps)).released).toBe(1);
  expect(existsSync(path.join(dirtyPath, "uncommitted.txt"))).toBe(true);
  expect(await getWorktree(sql, dirtyPath)).toMatchObject({ state: "abandoned-dirty" });

  // Leave no fixture behind after proving preservation.
  git(dirtyPath, "clean", "-fd");
  await releaseRunResources(
    { onSuccess: "release", onFailure: "release" },
    metadata,
    sql,
    "success",
  );
});
