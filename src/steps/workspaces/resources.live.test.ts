import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CLEANUP_STATE_ATTRIBUTE, encodeCleanupProgress } from "../../workflow/runtime/cleanup.ts";
import { resourceAttribute } from "../../workflow/runtime/resources.ts";
import { factorySlug } from "./layout.ts";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
  type RegistrySql,
  upsertWorktree,
  withRunResourceLock,
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
const workflowName = "workflow//./workflows/ship//shipWorkflow";
let db: RegistrySql;
let repoDir: string;
let worktreesDir: string;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  execFileSync("node_modules/.bin/bootstrap", [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: testUrl.toString() },
    stdio: "ignore",
  });
  db = connectRegistry(testUrl.toString(), { max: 2 });
  await ensureWorktreeRegistry(db);
  mkdirSync(factoryRoot, { recursive: true });
  const binding = path.join(dataDir, "bindings", factorySlug(factoryRoot), "api");
  ({ repoDir, worktreesDir } = makeClonedBinding(tmp, binding));
});

afterAll(async () => {
  await db?.$client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
});

function resourceRun(
  runId: string,
  branch: string,
  status: string,
  action: "keep" | "release",
): { run: ResourceRun; target: string; scratch: string } {
  const target = path.join(worktreesDir, branch);
  git(repoDir, "worktree", "add", "-q", target, "-b", branch, "refs/remotes/origin/main");
  const scratch = path.join(dataDir, "scratch", runId);
  mkdirSync(scratch, { recursive: true });
  const worktree = resourceAttribute({
    kind: "worktree",
    identity: target,
    url: pathToFileURL(target).href,
  });
  const runDirectory = resourceAttribute({
    kind: "run-directory",
    identity: runId,
    url: pathToFileURL(scratch).href,
  });
  return {
    target,
    scratch,
    run: {
      runId,
      workflowName,
      status,
      attributes: {
        [worktree.key]: worktree.value,
        [runDirectory.key]: runDirectory.value,
        [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({
          status: action === "keep" ? "kept" : "running",
          outcome: action === "keep" ? "success" : "failure",
          action,
        }),
      },
    },
  };
}

async function insertRun(run: ResourceRun): Promise<void> {
  await db.$client.query(
    `insert into "workflow"."workflow_runs"
      (id, deployment_id, status, name, attributes)
     values ($1, 'postgres', $2, $3, $4::jsonb)`,
    [run.runId, run.status, run.workflowName, JSON.stringify(run.attributes)],
  );
}

async function registerWorktree(runId: string, target: string, branch: string): Promise<void> {
  await upsertWorktree(db, {
    path: target,
    branch,
    ownerRunId: runId,
    state: "active",
    repoDir,
  });
}

function inventory(run: ResourceRun, target: string) {
  return {
    runs: [run],
    worktrees: [
      {
        path: target,
        branch: path.basename(target),
        ownerRunId: run.runId,
        state: "active",
        repoDir,
      },
    ],
    factoryRoot,
    dataDir,
    ownedWorkflowIds: new Set([run.workflowName]),
  };
}

test("locked DB revalidation preserves resources when the run becomes live and kept", async () => {
  const runId = "wrun_live_resources_race";
  const branch = "race-preserved";
  const preview = resourceRun(runId, branch, "cancelled", "release");
  await registerWorktree(runId, preview.target, branch);
  await insertRun(preview.run);
  const keptAttributes = {
    ...preview.run.attributes,
    [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({
      status: "kept",
      outcome: "success",
      action: "keep",
    }),
  };
  let historyAfterMutation: unknown[] = [];

  const mutateAfterLock = <T>(
    sql: RegistrySql,
    lockedRunId: string,
    action: (locked: RegistrySql) => Promise<T>,
  ) =>
    withRunResourceLock(sql, lockedRunId, async (locked) => {
      await sql.$client.query(
        `update "workflow"."workflow_runs"
         set status = 'running', attributes = $2::jsonb
         where id = $1`,
        [runId, JSON.stringify(keptAttributes)],
      );
      historyAfterMutation = (
        await sql.$client.query('select * from "workflow"."workflow_runs" where id = $1', [runId])
      ).rows;
      return action(locked);
    });

  const result = await pruneResources(inventory(preview.run, preview.target), db, mutateAfterLock);

  expect(result.entries).toHaveLength(2);
  expect(result.entries.every((entry) => entry.action === "skip" && !entry.eligible)).toBe(true);
  expect(result.entries.every((entry) => entry.reason.includes("not terminal"))).toBe(true);
  expect(existsSync(preview.target)).toBe(true);
  expect(existsSync(preview.scratch)).toBe(true);
  expect(await getWorktree(db, preview.target)).not.toBeNull();
  expect(
    (await db.$client.query('select * from "workflow"."workflow_runs" where id = $1', [runId]))
      .rows,
  ).toEqual(historyAfterMutation);
});

test("locked DB revalidation still removes unchanged terminal resources", async () => {
  const runId = "wrun_live_resources_terminal";
  const branch = "terminal-removed";
  const fixture = resourceRun(runId, branch, "cancelled", "release");
  await registerWorktree(runId, fixture.target, branch);
  await insertRun(fixture.run);
  const historyBefore = (
    await db.$client.query('select * from "workflow"."workflow_runs" where id = $1', [runId])
  ).rows;

  const result = await pruneResources(inventory(fixture.run, fixture.target), db);

  expect(result.entries).toMatchObject([{ action: "remove" }, { action: "remove" }]);
  expect(existsSync(fixture.target)).toBe(false);
  expect(existsSync(fixture.scratch)).toBe(false);
  expect(await getWorktree(db, fixture.target)).toBeNull();
  expect(
    (await db.$client.query('select * from "workflow"."workflow_runs" where id = $1', [runId]))
      .rows,
  ).toEqual(historyBefore);
});
