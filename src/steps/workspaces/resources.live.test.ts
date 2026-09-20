import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CLEANUP_STATE_ATTRIBUTE, encodeCleanupProgress } from "../../blocks/runtime/cleanup.ts";
import { resourceAttribute } from "../../blocks/runtime/resources.ts";
import { factorySlug } from "./layout.ts";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
  type RegistrySql,
  upsertWorktree,
} from "./registry.ts";
import { pruneResources, type ResourceRun } from "./resources.ts";
import { git, makeClonedBinding, makeTmpDir } from "./test-fixtures.ts";

const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_resources_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const tmp = makeTmpDir();
const factoryRoot = path.join(tmp, "factory");
const dataDir = path.join(tmp, "data", "jigs");
let db: RegistrySql;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  db = connectRegistry(testUrl.toString(), { max: 2 });
  await ensureWorktreeRegistry(db);
  mkdirSync(factoryRoot, { recursive: true });
});

afterAll(async () => {
  await db?.$client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
});

test("offline apply uses the real advisory lock and leaves SDK history untouched", async () => {
  const runId = "wrun_live_resources";
  const branch = "merged";
  const binding = path.join(dataDir, "bindings", factorySlug(factoryRoot), "api");
  const { repoDir, worktreesDir } = makeClonedBinding(tmp, binding);
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  await upsertWorktree(db, { path: target, branch, ownerRunId: runId, state: "active", repoDir });
  const resource = resourceAttribute({
    kind: "worktree",
    identity: target,
    url: pathToFileURL(target).href,
  });
  const run: ResourceRun = {
    runId,
    workflowName: "workflow//./workflows/ship//shipWorkflow",
    status: "cancelled",
    attributes: {
      [resource.key]: resource.value,
      [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({
        status: "running",
        outcome: "failure",
        action: "release",
      }),
    },
  };

  const result = await pruneResources(
    {
      runs: [run],
      worktrees: [await getWorktree(db, target)].filter((row) => row !== null),
      factoryRoot,
      dataDir,
      ownedWorkflowIds: new Set([run.workflowName]),
    },
    db,
  );
  expect(result.entries).toMatchObject([{ action: "remove" }]);
  expect(await getWorktree(db, target)).toBeNull();
});
