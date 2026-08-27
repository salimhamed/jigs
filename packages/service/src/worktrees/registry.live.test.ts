import { afterAll, expect, test } from "vitest";
import {
  connectRegistry,
  deleteWorktree,
  ensureWorktreeRegistry,
  getWorktree,
  listWorktrees,
  setWorktreeState,
  upsertWorktree,
  type WorktreeRow,
} from "./registry";

const sql = connectRegistry(
  process.env.WORKFLOW_POSTGRES_URL ??
    "postgres://jigs:jigs@localhost:5439/jigs",
  { max: 1 },
);

const testPath = `/tmp/jigs-registry-live/${crypto.randomUUID()}`;

afterAll(async () => {
  await sql`DELETE FROM jigs_worktrees WHERE path = ${testPath}`;
  await sql.end();
});

function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: testPath,
    branch: "feat",
    ownerRunId: "run_a",
    state: "active",
    baseSha: "base1",
    headSha: "head1",
    behindDefault: 3,
    binding: "api",
    checkoutRoot: "/repos/api",
    keep: false,
    ...overrides,
  };
}

test("ensureWorktreeRegistry is idempotent", async () => {
  await ensureWorktreeRegistry(sql);
  await expect(ensureWorktreeRegistry(sql)).resolves.toBeUndefined();
});

test("upsert inserts a row carrying owner, state, and the sha triple", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  expect(await getWorktree(sql, testPath)).toEqual(row());
});

test("re-upsert with a new owner updates the row in place", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  await upsertWorktree(
    sql,
    row({ ownerRunId: "run_b", headSha: "head2", behindDefault: 0 }),
  );
  expect(await getWorktree(sql, testPath)).toEqual(
    row({ ownerRunId: "run_b", headSha: "head2", behindDefault: 0 }),
  );
});

test("getWorktree misses cleanly on an unregistered path", async () => {
  await ensureWorktreeRegistry(sql);
  expect(await getWorktree(sql, "/nowhere/never-registered")).toBeNull();
});

test("the row carries its binding, checkout root, and keep flag", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row({ keep: true }));
  expect(await getWorktree(sql, testPath)).toMatchObject({
    binding: "api",
    checkoutRoot: "/repos/api",
    keep: true,
  });
});

test("listWorktrees returns the live rows", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  const paths = (await listWorktrees(sql)).map((r) => r.path);
  expect(paths).toContain(testPath);
});

test("setWorktreeState marks a row without touching the rest of it", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  await setWorktreeState(sql, testPath, "abandoned-dirty");
  expect(await getWorktree(sql, testPath)).toEqual(
    row({ state: "abandoned-dirty" }),
  );
});

test("deleteWorktree drops the row — the registry holds live worktrees only", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  await deleteWorktree(sql, testPath);
  expect(await getWorktree(sql, testPath)).toBeNull();
});

test("ensure upgrades a table created before binding, checkout_root, and keep existed", async () => {
  const legacy = "jigs_worktrees_legacy_probe";
  await sql`DROP TABLE IF EXISTS ${sql(legacy)}`;
  await sql`
    CREATE TABLE ${sql(legacy)} (
      path text PRIMARY KEY,
      branch text NOT NULL,
      owner_run_id text NOT NULL,
      state text NOT NULL,
      base_sha text NOT NULL,
      head_sha text NOT NULL,
      behind_default integer NOT NULL
    )
  `;
  // The ALTERs in ensureWorktreeRegistry, applied to the pre-column shape.
  await sql`ALTER TABLE ${sql(legacy)} ADD COLUMN IF NOT EXISTS binding text NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE ${sql(legacy)} ADD COLUMN IF NOT EXISTS checkout_root text NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE ${sql(legacy)} ADD COLUMN IF NOT EXISTS keep boolean NOT NULL DEFAULT false`;
  const columns = await sql<{ columnName: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${legacy}
  `;
  expect(columns.map((c) => c.columnName)).toEqual(
    expect.arrayContaining(["binding", "checkout_root", "keep"]),
  );
  await sql`DROP TABLE ${sql(legacy)}`;
});
