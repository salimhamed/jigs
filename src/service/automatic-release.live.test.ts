import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createWorld } from "@workflow/world-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { setWorld } from "workflow/runtime";
import {
  currentFactory,
  ensureRegistry,
  listResources,
  type RegistrySql,
  registrySql,
} from "../steps/runtime/registry.ts";
import { createRunDirectory } from "../steps/runtime/run-directory/index.ts";
import { provisionWorktree } from "../steps/workspaces/index.ts";
import { cloneDir, worktreePath } from "../steps/workspaces/layout.ts";
import { makeClonedBinding, makeTmpDir, removeTmpDir } from "../steps/workspaces/test-fixtures.ts";
import type { Factory } from "../workflow/factory.ts";
import { automaticReleaseDeps, startAutomaticRelease } from "./automatic-release.ts";

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

  remoteDir = makeClonedBinding(tmp, cloneDir(dirs)).remoteDir;
  target = worktreePath({ ...dirs, branch });
  mkdirSync(factoryRoot, { recursive: true });
  writeFileSync(
    path.join(factoryRoot, "jigs.config.ts"),
    `export default ${JSON.stringify({ bindings: { api: { remote: remoteDir } }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} })};`,
  );
  registry = registrySql();
  await ensureRegistry(registry);
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

const states = async (runId: string) =>
  (await listResources(registry, { factory: currentFactory(), runId })).map((row) => [
    row.kind,
    row.state,
    row.reason,
  ]);

test("startup reconciliation releases what a failed pass before a World restart left live", async () => {
  const runId = await createCompletedRun();
  const metadata = { workflowRunId: runId };
  await provisionWorktree({ binding: "api", branch }, metadata);
  const directory = await createRunDirectory(metadata);

  const warn = vi.fn();
  const first = startAutomaticRelease(factory, {
    ...automaticReleaseDeps(),
    ready: () => true,
    warn,
    release: async () => {
      throw new Error("transient cleanup failure before restart");
    },
  });
  await until(() => warn.mock.calls.length > 0, "first coordinator did not attempt release");
  await first.stop();
  expect(existsSync(target)).toBe(true);
  expect(await states(runId)).toEqual([
    ["worktree", "live", null],
    ["run-directory", "live", null],
  ]);

  await world.close?.();
  setWorld(undefined);
  world = await startWorld();

  const restarted = startAutomaticRelease(factory, {
    ...automaticReleaseDeps(),
    ready: () => true,
  });
  await until(
    async () => (await states(runId)).every(([, state]) => state === "released"),
    "restarted coordinator did not release the run's resources",
  );
  await restarted.stop();

  expect(await states(runId)).toEqual([
    ["worktree", "released", "worktree and merged branch removed"],
    ["run-directory", "released", "removed"],
  ]);
  expect(existsSync(target)).toBe(false);
  expect(existsSync(directory)).toBe(false);
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
  await world.events.create(runId, {
    eventType: "run_completed",
    eventData: { output: new Uint8Array() },
  });
  return runId;
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
