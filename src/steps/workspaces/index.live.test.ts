import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  type AutomaticReleaseDeps,
  reconcileAutomaticRelease,
} from "../../service/automatic-release.ts";
import type { Factory } from "../../workflow/factory.ts";
import {
  currentFactory,
  ensureRegistry,
  listResources,
  registrySql,
  withRunResourceLock,
} from "../runtime/registry.ts";
import { releaseRun } from "../runtime/release.ts";
import { createRunDirectory } from "../runtime/run-directory/index.ts";
import { readRunState } from "../runtime/run-state.ts";
import { provisionWorktree } from "./index.ts";
import { cloneDir } from "./layout.ts";
import { git, makeClonedBinding, makeTmpDir, removeTmpDir } from "./test-fixtures.ts";

// Real Postgres, a real clone and real cuts: provisioning, explicit release and
// automatic release all through the one registry and the one release function.
const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_workspaces_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });

const tmp = makeTmpDir();
const factoryRoot = path.join(tmp, "factory");
mkdirSync(factoryRoot, { recursive: true });
vi.stubEnv("JIGS_FACTORY_ROOT", factoryRoot);
vi.stubEnv("XDG_DATA_HOME", path.join(tmp, "data"));
vi.stubEnv("WORKFLOW_POSTGRES_URL", testUrl.toString());

const dirs = { factoryRoot, bindingName: "api" };
const { remoteDir } = makeClonedBinding(tmp, cloneDir(dirs));
writeFileSync(
  path.join(factoryRoot, "jigs.config.ts"),
  `export default ${JSON.stringify({ bindings: { api: { remote: remoteDir } }, service: { port: 8990, dashboardPort: 9090 }, workflows: {} })};`,
);

const sql = () => registrySql();
const finished = { runStatus: async () => "completed" };
const states = async (runId: string) =>
  (await listResources(sql(), { factory: currentFactory(), runId })).map((row) => [
    row.kind,
    row.state,
    row.reason,
  ]);

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  await ensureRegistry(sql());
});
afterAll(async () => {
  await sql().$client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  vi.unstubAllEnvs();
  removeTmpDir(tmp);
});

test("a relaunched ticket adopts the leftover worktree and the old record steps aside", async () => {
  const request = { binding: "api", branch: "adopt" };
  const first = await provisionWorktree(request, { workflowRunId: "run_first" });
  writeFileSync(path.join(first.path, "shipped.txt"), "shipped\n");
  git(first.path, "add", "shipped.txt");
  git(first.path, "commit", "-q", "-m", "shipped");
  const head = git(first.path, "rev-parse", "HEAD");

  const second = await provisionWorktree(request, { workflowRunId: "run_second" }, finished);

  expect(second.path).toBe(first.path);
  expect(git(second.path, "rev-parse", "HEAD")).toBe(head);
  expect(await states("run_first")).toEqual([["worktree", "released", "reused by run run_second"]]);
  expect(await states("run_second")).toEqual([["worktree", "live", null]]);
});

test("a live owner read back from the registry refuses the second run by name", async () => {
  const request = { binding: "api", branch: "held" };
  await provisionWorktree(request, { workflowRunId: "run_live" });

  await expect(
    provisionWorktree(
      request,
      { workflowRunId: "run_other" },
      { runStatus: async () => "running" },
    ),
  ).rejects.toThrow(/run_live/);
  expect(await states("run_live")).toEqual([["worktree", "live", null]]);
  expect(await states("run_other")).toEqual([]);
});

test("explicit release keeps, then removes, through the real registry", async () => {
  const runId = "run_release";
  const tree = await provisionWorktree(
    { binding: "api", branch: "released" },
    { workflowRunId: runId },
  );
  const directory = await createRunDirectory({ workflowRunId: runId });
  const release = (action: "release" | "keep") =>
    withRunResourceLock(sql(), runId, (locked) =>
      releaseRun(locked, currentFactory(), runId, action, "onSuccess policy keeps run resources"),
    );

  await release("keep");
  expect(existsSync(tree.path)).toBe(true);
  expect(await states(runId)).toEqual([
    ["worktree", "kept", "onSuccess policy keeps run resources"],
    ["run-directory", "kept", "onSuccess policy keeps run resources"],
  ]);

  // Kept records are final for release; only prune takes them further.
  await release("release");
  expect(existsSync(tree.path)).toBe(true);
  expect(existsSync(directory)).toBe(true);
});

test("automatic release uses the same release and preserves dirty work", async () => {
  const runId = "run_automatic";
  const tree = await provisionWorktree(
    { binding: "api", branch: "dirty" },
    { workflowRunId: runId },
  );
  const directory = await createRunDirectory({ workflowRunId: runId });
  writeFileSync(path.join(tree.path, "uncommitted.txt"), "keep me\n");
  const readState = (id: string) =>
    readRunState(sql(), currentFactory(), id, async () => ({
      status: "completed",
      workflowName: "workflow//./workflows/ship//ship",
      tokens: [],
    }));
  const deps: AutomaticReleaseDeps = {
    pendingRuns: async () => [await readState(runId)],
    readState,
    waitForTerminal: async () => undefined,
    hasActiveStep: async () => false,
    policy: () => "release",
    withLock: (id, action) => withRunResourceLock(sql(), id, action),
    release: (locked, run, action, keepReason) =>
      releaseRun(locked, currentFactory(), run.runId, action, keepReason),
    ready: () => true,
    log: () => undefined,
    warn: () => undefined,
    setTimer: () => () => undefined,
  };

  expect((await reconcileAutomaticRelease({ workflows: {} } as Factory, deps)).released).toBe(1);
  expect(existsSync(path.join(tree.path, "uncommitted.txt"))).toBe(true);
  expect(existsSync(directory)).toBe(false);
  expect(await states(runId)).toEqual([
    ["worktree", "kept", "uncommitted work kept"],
    ["run-directory", "released", "removed"],
  ]);
  expect((await readState(runId)).resources.map((record) => record.state)).toEqual([
    "kept",
    "released",
  ]);
});
