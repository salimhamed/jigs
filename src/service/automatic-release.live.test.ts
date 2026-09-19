import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { setWorld } from "workflow/runtime";
import type { Factory } from "../blocks/factory.ts";
import {
  CLEANUP_DIRECTIVE_ATTRIBUTE,
  CLEANUP_STATE_ATTRIBUTE,
  cleanupFromAttributes,
  encodeCleanupProgress,
} from "../blocks/runtime/cleanup.ts";
import { writeCleanupProgress } from "../steps/runtime/cleanup-state.ts";
import { createRunDirectory } from "../steps/runtime/run-directory/index.ts";
import { provisionWorktree } from "../steps/workspaces/index.ts";
import { bindingDir, worktreePath } from "../steps/workspaces/layout.ts";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
  listWorktreesForRun,
  type RegistrySql,
  withRunResourceLock,
} from "../steps/workspaces/registry.ts";
import { releaseRunResources } from "../steps/workspaces/release.ts";
import { makeClonedBinding, makeTmpDir, removeTmpDir } from "../steps/workspaces/test-fixtures.ts";
import {
  type AutomaticReleaseDeps,
  type CleanupRun,
  startAutomaticRelease,
} from "./automatic-release.ts";
import { runsWithActiveStep } from "./stalls.ts";

const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_cleanup_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const service = createServer();
const tmp = makeTmpDir();
const factoryRoot = path.join(tmp, "factory");
const dataRoot = path.join(tmp, "data");
const dirs = { factoryRoot, bindingName: "api" };
const branch = "restart-recovery";
const factory = { workflows: {} } as Factory;

let registry: RegistrySql;
let world: ReturnType<typeof createWorld>;
let remoteDir: string;
let target: string;
let oldBaseUrl: string | undefined;
let oldPostgresUrl: string | undefined;
let oldFactoryRoot: string | undefined;
let oldDataHome: string | undefined;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  execFileSync("node_modules/.bin/bootstrap", [], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: testUrl.toString() },
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const address = service.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture service did not bind");

  oldBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
  oldPostgresUrl = process.env.WORKFLOW_POSTGRES_URL;
  oldFactoryRoot = process.env.JIGS_FACTORY_ROOT;
  oldDataHome = process.env.XDG_DATA_HOME;
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.WORKFLOW_POSTGRES_URL = testUrl.toString();
  process.env.JIGS_FACTORY_ROOT = factoryRoot;
  process.env.XDG_DATA_HOME = dataRoot;

  remoteDir = makeClonedBinding(tmp, bindingDir(dirs)).remoteDir;
  target = worktreePath({ ...dirs, branch });
  mkdirSync(factoryRoot, { recursive: true });
  writeFileSync(
    path.join(factoryRoot, "jigs.config.ts"),
    `export default ${JSON.stringify({ bindings: { api: { remote: remoteDir } }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} })};`,
  );
  registry = connectRegistry(testUrl.toString(), { max: 2 });
  await ensureWorktreeRegistry(registry);
  world = await startWorld();
});

afterAll(async () => {
  await world?.close?.();
  setWorld(undefined);
  await registry?.$client.end();
  await new Promise<void>((resolve) => service.close(() => resolve()));
  await until(async () => {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",
      [database],
    );
    return rows[0].count === 0;
  }, "cleanup fixture database still has connected clients after shutdown");
  await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
  restoreEnv("WORKFLOW_LOCAL_BASE_URL", oldBaseUrl);
  restoreEnv("WORKFLOW_POSTGRES_URL", oldPostgresUrl);
  restoreEnv("JIGS_FACTORY_ROOT", oldFactoryRoot);
  restoreEnv("XDG_DATA_HOME", oldDataHome);
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("startup reconciliation recovers persisted cleanup after a World restart", async () => {
  const runId = await createCompletedRun();
  const metadata = { workflowRunId: runId };
  await provisionWorktree({ binding: "api", branch }, metadata, { sql: registry });
  const directory = await createRunDirectory(metadata);

  const first = startAutomaticRelease(
    factory,
    coordinatorDeps(async () => {
      throw new Error("transient cleanup failure before restart");
    }),
  );
  await until(async () => {
    const run = await world.runs.get(runId, { resolveData: "none" });
    return cleanupFromAttributes(run.attributes).status === "failed";
  }, "first coordinator did not persist failed cleanup");
  await first.stop();
  expect(existsSync(target)).toBe(true);
  expect(await getWorktree(registry, target)).not.toBeNull();

  await world.close?.();
  setWorld(undefined);
  world = await startWorld();
  const persisted = cleanupFromAttributes(
    (await world.runs.get(runId, { resolveData: "none" })).attributes,
  );
  expect(persisted).toMatchObject({
    status: "failed",
    action: "release",
    outcome: "success",
  });

  const restarted = startAutomaticRelease(factory, coordinatorDeps());
  await until(async () => {
    const run = await world.runs.get(runId, { resolveData: "none" });
    return cleanupFromAttributes(run.attributes).status === "complete";
  }, "restarted coordinator did not finish persisted cleanup");
  await restarted.stop();

  const completed = cleanupFromAttributes(
    (await world.runs.get(runId, { resolveData: "none" })).attributes,
  );
  expect(completed).toMatchObject({
    status: "complete",
    action: "release",
    outcome: "success",
    released: 2,
    failed: 0,
  });
  expect(existsSync(target)).toBe(false);
  expect(existsSync(directory)).toBe(false);
  expect(await getWorktree(registry, target)).toBeNull();
});

async function startWorld(): Promise<ReturnType<typeof createWorld>> {
  const next = createWorld({
    connectionString: testUrl.toString(),
    applicationManagedShutdown: true,
  });
  setWorld(next);
  await next.start();
  return next;
}

async function createCompletedRun(): Promise<string> {
  const created = await world.events.create(null, {
    eventType: "run_created",
    eventData: {
      deploymentId: "postgres",
      workflowName: "workflow//./workflows/cleanup//cleanup",
      input: new Uint8Array(),
      executionContext: { workflowCoreVersion: "5.0.0-beta.53", workflowVm: "node" },
    },
  });
  if (created.run === undefined) throw new Error("run_created returned no run");
  const runId = created.run.runId;
  await world.events.create(runId, { eventType: "run_started" });
  const setter = world.runs.experimentalSetAttributes;
  if (setter === undefined) throw new Error("Postgres World does not support run attributes");
  await setter(
    runId,
    [
      { key: CLEANUP_DIRECTIVE_ATTRIBUTE, value: "automatic" },
      { key: CLEANUP_STATE_ATTRIBUTE, value: encodeCleanupProgress({ status: "waiting" }) },
    ],
    { allowReservedAttributes: true },
  );
  await world.events.create(runId, {
    eventType: "run_completed",
    eventData: { output: new Uint8Array() },
  });
  return runId;
}

function coordinatorDeps(
  release: AutomaticReleaseDeps["release"] = (run, action, outcome, sql) =>
    releaseRunResources(
      { onSuccess: action, onFailure: action },
      { workflowRunId: run.runId },
      sql,
      outcome,
    ),
): AutomaticReleaseDeps {
  return {
    listRuns: async () => {
      const page = await world.runs.list({
        resolveData: "none",
        pagination: { limit: 1000 },
      });
      return page.data as CleanupRun[];
    },
    waitForTerminal: async (runId, signal) => {
      const wait = world.runs.waitForTerminalStatus;
      if (wait === undefined) throw new Error("Postgres World does not support terminal waits");
      return wait(runId, {
        resolveData: "none",
        timeoutMs: 60_000,
        signal,
      }) as Promise<CleanupRun>;
    },
    hasActiveStep: async (runId) => (await runsWithActiveStep([runId])).length > 0,
    policy: () => "release",
    withLock: (runId, action) => withRunResourceLock(registry, runId, action),
    worktreeCount: async (runId, sql) => (await listWorktreesForRun(sql, runId)).length,
    release,
    writeProgress: (runId, progress) => writeCleanupProgress(runId, progress),
    ready: () => true,
    log: () => undefined,
    warn: () => undefined,
    setTimer: () => () => undefined,
  };
}

async function until(
  check: () => Promise<boolean> | boolean,
  message: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
