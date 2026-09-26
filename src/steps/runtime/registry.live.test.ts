import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ticketToken } from "../../workflow/linear/claim.ts";
import { pullRequestToken } from "../../workflow/pull-requests/pull-request.ts";
import {
  alsoLockRun,
  connectRegistry,
  ensureRegistry,
  listResources,
  migrateRegistry,
  type RegistrySql,
  recordResource,
  setResourceState,
  withRunResourceLock,
} from "./registry.ts";
import { readRunState } from "./run-state.ts";

// Every suite owns its databases, including migration history. Never rebuild a
// table in an existing development or factory database to test a migration.
const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const created: string[] = [];

async function freshDatabase(): Promise<{ url: string; db: RegistrySql }> {
  const name = `jigs_registry_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  created.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { url: url.toString(), db: connectRegistry(url.toString(), { max: 2 }) };
}

let db: RegistrySql;
let dbUrl: string;
const adminUrlFor = (_db: RegistrySql) => dbUrl;
beforeAll(async () => {
  ({ db, url: dbUrl } = await freshDatabase());
  await ensureRegistry(db);
});
afterAll(async () => {
  await db.$client.end();
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

test("a failed attempt's count is kept until the record is live again", async () => {
  const counted = { ...key, factory: "factory-attempts" };
  await recordResource(db, { ...counted, url: "file:///w/feat", repoDir: "/r", branch: "feat" });
  await setResourceState(db, counted, "failed", "release failed: EBUSY", 3);
  expect((await listResources(db, { factory: "factory-attempts" }))[0]?.attempts).toBe(3);
  await recordResource(db, { ...counted, url: "file:///w/feat" });
  expect((await listResources(db, { factory: "factory-attempts" }))[0]).toMatchObject({
    state: "live",
    attempts: 0,
  });
});

const tables = async (target: RegistrySql) =>
  (
    await target.$client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    )
  ).rows.map((row) => row.table_name);

const migrations = async (target: RegistrySql) =>
  (await target.$client.query("SELECT id FROM jigs_drizzle.jigs_migrations")).rows;

test("a fresh database gets the resource table, twice without change", async () => {
  const fresh = await freshDatabase();
  try {
    await ensureRegistry(fresh.db);
    await ensureRegistry(fresh.db);
    expect(await tables(fresh.db)).toEqual(["jigs_resources"]);
    expect(await migrations(fresh.db)).toHaveLength(2);
  } finally {
    await fresh.db.$client.end();
  }
});

test("a database with the old worktree table loses it without touching World history", async () => {
  const old = await freshDatabase();
  try {
    await old.db.$client.query("CREATE SCHEMA workflow_drizzle");
    await old.db.$client.query(
      "CREATE TABLE workflow_drizzle.workflow_migrations (id int, hash text)",
    );
    await old.db.$client.query(
      "INSERT INTO workflow_drizzle.workflow_migrations VALUES (42, 'world')",
    );
    // Exactly what the previous release left behind: its one migration applied, with a row.
    const sql = readFileSync(
      new URL("../../../migrations/0000_worktree_registry.sql", import.meta.url),
      "utf8",
    );
    await old.db.$client.query(sql);
    await old.db.$client.query(
      "INSERT INTO jigs_worktrees (path, branch, owner_run_id, state, repo_dir) VALUES ('/w', 'b', 'run', 'active', '/r')",
    );
    await old.db.$client.query("CREATE SCHEMA jigs_drizzle");
    await old.db.$client.query(
      "CREATE TABLE jigs_drizzle.jigs_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    await old.db.$client.query(
      "INSERT INTO jigs_drizzle.jigs_migrations (hash, created_at) VALUES ($1, 1789689600000)",
      [createHash("sha256").update(sql).digest("hex")],
    );

    await migrateRegistry(old.url);

    expect(await tables(old.db)).toEqual(["jigs_resources"]);
    expect(await migrations(old.db)).toHaveLength(2);
    expect(
      (await old.db.$client.query("SELECT * FROM workflow_drizzle.workflow_migrations")).rows,
    ).toEqual([{ id: 42, hash: "world" }]);
  } finally {
    await old.db.$client.end();
  }
});

const key = { factory: "factory-a", runId: "run_1", kind: "worktree", identity: "/w/feat" };

test("recording again refreshes the URL and liveness but keeps creation and kind columns", async () => {
  await recordResource(db, {
    ...key,
    url: "file:///w/feat",
    repoDir: "/r/repo.git",
    branch: "feat",
  });
  await setResourceState(db, key, "kept", "uncommitted work kept");
  await db.$client.query(
    "UPDATE jigs_resources SET created_at = '2020-01-01', updated_at = '2020-01-01'",
  );

  await recordResource(db, { ...key, url: "file:///w/feat?again" });

  const [row] = await listResources(db, { factory: "factory-a", runId: "run_1" });
  expect(row).toMatchObject({
    ...key,
    url: "file:///w/feat?again",
    state: "live",
    reason: null,
    repoDir: "/r/repo.git",
    branch: "feat",
    createdAt: new Date("2020-01-01"),
  });
  expect(row?.updatedAt.getTime()).toBeGreaterThan(new Date("2020-01-01").getTime());
});

test("rows are this factory's alone and filter by run, kind, identity and state", async () => {
  await recordResource(db, { ...key, factory: "factory-b", url: "file:///w/feat" });
  await recordResource(db, {
    ...key,
    kind: "run-directory",
    identity: "run_1",
    url: "file:///s/run_1",
  });
  await setResourceState(
    db,
    { ...key, kind: "run-directory", identity: "run_1" },
    "released",
    "removed",
  );

  expect(
    (await listResources(db, { factory: "factory-a", states: ["live", "kept"] })).map(
      (row) => row.kind,
    ),
  ).toEqual(["worktree"]);
  expect(
    (await listResources(db, { factory: "factory-a", kind: "worktree", identity: "/w/feat" })).map(
      (row) => row.factory,
    ),
  ).toEqual(["factory-a"]);
  expect(await listResources(db, { factory: "factory-c" })).toEqual([]);
});

test("a run's state is its records plus the hooks the World holds", async () => {
  const claim = ticketToken("68bc9696-35d5-442d-ab56-214c8cfefbec");
  const watch = pullRequestToken({ owner: "acme", repo: "api", number: 41 });

  const state = await readRunState(db, "factory-a", "run_1", async () => ({
    run: {
      status: "running",
      workflowName: "workflow//./workflows/ship//ship",
      trigger: "manual",
      ticket: "AGE-12",
      createdAt: new Date("2026-09-26T00:00:00.000Z"),
    },
    tokens: [claim, watch],
    steps: [],
  }));

  expect(state).toEqual({
    runId: "run_1",
    status: "suspended",
    workflowName: "workflow//./workflows/ship//ship",
    trigger: "manual",
    ticket: "AGE-12",
    createdAt: "2026-09-26T00:00:00.000Z",
    lastActivityAt: "2026-09-26T00:00:00.000Z",
    steps: 0,
    lastStep: null,
    suspended: true,
    resources: [
      {
        runId: "run_1",
        kind: "worktree",
        identity: "/w/feat",
        url: "file:///w/feat?again",
        state: "live",
        reason: null,
        updatedAt: expect.any(String),
      },
      {
        runId: "run_1",
        kind: "run-directory",
        identity: "run_1",
        url: "file:///s/run_1",
        state: "released",
        reason: "removed",
        updatedAt: expect.any(String),
      },
    ],
    claim,
    suspensions: [
      {
        token: watch,
        kind: "pull-request",
        reason: "waiting for pull request activity on acme/api#41",
        url: "https://github.com/acme/api/pull/41",
      },
    ],
  });
});

test("the run lock serializes holders of the same run", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withRunResourceLock(db, "run_lock", async () => {
    order.push("first");
    await gate;
    order.push("first done");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = withRunResourceLock(db, "run_lock", async () => {
    order.push("second");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "first done", "second"]);
});

test("a run locked alongside another is freed when the outer lock ends", async () => {
  await withRunResourceLock(db, "run_outer", (locked) => alsoLockRun(locked, "run_inner"));
  const other = connectRegistry(adminUrlFor(db), { max: 1 });
  try {
    const { rows } = await other.$client.query(
      "select pg_try_advisory_lock(hashtextextended('run_inner', 464)) as free",
    );
    expect(rows[0].free).toBe(true);
  } finally {
    await other.$client.end();
  }
});
