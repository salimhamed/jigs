import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  connectRegistry,
  deleteWorktree,
  ensureWorktreeRegistry,
  getWorktree,
  listWorktrees,
  listWorktreesForRun,
  migrateRegistry,
  setWorktreeState,
  upsertWorktree,
  type WorktreeRow,
} from "./registry.ts";

// Every suite owns its database, including migration history. Never rebuild a
// table in an existing development or factory database to test a migration.
const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const database = `jigs_registry_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const db = connectRegistry(testUrl.toString(), { max: 1 });

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
});
afterAll(async () => {
  await db.$client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
});

const initial: WorktreeRow = {
  path: "/initial/worktree",
  branch: "feature",
  ownerRunId: "run_initial",
  state: "active",
  repoDir: "/initial/repo.git",
};

test("creates the registry without touching the World's migration history", async () => {
  await db.$client.query("CREATE SCHEMA workflow_drizzle");
  await db.$client.query("CREATE TABLE workflow_drizzle.workflow_migrations (id int, hash text)");
  await db.$client.query(
    "INSERT INTO workflow_drizzle.workflow_migrations VALUES (42, 'world-history')",
  );
  await migrateRegistry(testUrl.toString());
  expect(await listWorktrees(db)).toEqual([]);
  await upsertWorktree(db, initial);
  await db.$client.query("UPDATE jigs_worktrees SET created_at = $1, updated_at = $1", [
    new Date("2020-01-01"),
  ]);
  expect(
    (await db.$client.query("SELECT * FROM workflow_drizzle.workflow_migrations")).rows,
  ).toEqual([{ id: 42, hash: "world-history" }]);
  expect((await db.$client.query("SELECT * FROM jigs_drizzle.jigs_migrations")).rows).toHaveLength(
    1,
  );
});

test("repeated migration is a no-op and leaves the shared pool usable", async () => {
  const before = (await db.$client.query("SELECT * FROM jigs_drizzle.jigs_migrations")).rows;
  await ensureWorktreeRegistry(db);
  await ensureWorktreeRegistry(db);
  expect((await db.$client.query("SELECT * FROM jigs_drizzle.jigs_migrations")).rows).toEqual(
    before,
  );
  expect(await getWorktree(db, initial.path)).toEqual(initial);
});

test("fresh databases get the same schema and migration history", async () => {
  const freshName = `${database}_fresh`;
  await admin.query(`CREATE DATABASE "${freshName}"`);
  const freshUrl = new URL(testUrl);
  freshUrl.pathname = `/${freshName}`;
  const fresh = connectRegistry(freshUrl.toString(), { max: 1 });
  try {
    await ensureWorktreeRegistry(fresh);
    await ensureWorktreeRegistry(fresh);
    expect(await listWorktrees(fresh)).toEqual([]);
    await upsertWorktree(fresh, initial);
    expect(await getWorktree(fresh, initial.path)).toEqual(initial);
    expect(
      (await fresh.$client.query("SELECT * FROM jigs_drizzle.jigs_migrations")).rows,
    ).toHaveLength(1);
  } finally {
    await fresh.$client.end();
    await admin.query(`DROP DATABASE "${freshName}" WITH (FORCE)`);
  }
});

test("upsert preserves creation, updates fields and recency, and lists by owner", async () => {
  const second = {
    ...initial,
    path: "/second",
    ownerRunId: "run_second",
    state: "provision-failed",
  };
  await upsertWorktree(db, second);
  expect(await getWorktree(db, second.path)).toEqual(second);
  expect(await listWorktrees(db)).toEqual([second, initial]);
  const updated = {
    ...initial,
    branch: "new-branch",
    ownerRunId: second.ownerRunId,
    repoDir: "/new/repo.git",
    state: "abandoned-dirty",
  };
  await upsertWorktree(db, updated);
  expect(await getWorktree(db, initial.path)).toEqual(updated);
  expect(await listWorktreesForRun(db, second.ownerRunId)).toEqual([updated, second]);
  expect(await listWorktreesForRun(db, initial.ownerRunId)).toEqual([]);
  const [saved] = (
    await db.$client.query("SELECT created_at, updated_at FROM jigs_worktrees WHERE path = $1", [
      initial.path,
    ])
  ).rows;
  expect(saved.created_at).toEqual(new Date("2020-01-01"));
  expect(saved.updated_at.getTime()).toBeGreaterThan(saved.created_at.getTime());
});

test("state updates recency without changing ownership, then delete removes only its row", async () => {
  await db.$client.query("UPDATE jigs_worktrees SET updated_at = $1", [new Date("2020-01-01")]);
  await setWorktreeState(db, "/second", "active");
  const [first] = await listWorktrees(db);
  expect(first).toEqual({ ...initial, path: "/second", ownerRunId: "run_second" });
  await deleteWorktree(db, "/second");
  expect(await getWorktree(db, "/second")).toBeNull();
  expect(await listWorktrees(db)).toHaveLength(1);
  expect(await getWorktree(db, "/never-registered")).toBeNull();
});
