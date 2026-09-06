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
    repoDir: "/data/bindings/acme-abc12345/api/repo.git",
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

test("the row carries its repo dir", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  expect(await getWorktree(sql, testPath)).toMatchObject({
    repoDir: "/data/bindings/acme-abc12345/api/repo.git",
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

const CURRENT_COLUMNS = `
  path text PRIMARY KEY,
  branch text NOT NULL,
  owner_run_id text NOT NULL,
  state text NOT NULL,
  base_sha text NOT NULL,
  head_sha text NOT NULL,
  behind_default integer NOT NULL,
  repo_dir text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()`;

// Drops the real table and rebuilds it in an older shape: every other test
// here re-ensures it, and the live lane owns the dev database.
async function rebuildAs(columns: string): Promise<void> {
  await sql`DROP TABLE IF EXISTS jigs_worktrees`;
  await sql.unsafe(`CREATE TABLE jigs_worktrees (${columns})`);
}

test("a table that predates repo_dir is refused, naming the drop", async () => {
  await rebuildAs(
    CURRENT_COLUMNS.replace(
      "repo_dir text NOT NULL",
      "checkout_root text NOT NULL DEFAULT ''",
    ),
  );
  await expect(ensureWorktreeRegistry(sql)).rejects.toThrow(
    /missing repo_dir.*DROP TABLE jigs_worktrees/s,
  );
});

test("a table that still carries a retired column is refused, naming the drop", async () => {
  await rebuildAs(
    CURRENT_COLUMNS.replace(
      "repo_dir text NOT NULL,",
      "repo_dir text NOT NULL,\n  keep boolean NOT NULL DEFAULT false,",
    ),
  );
  await expect(ensureWorktreeRegistry(sql)).rejects.toThrow(
    /unexpected keep.*DROP TABLE jigs_worktrees/s,
  );

  await sql`DROP TABLE jigs_worktrees`;
  await expect(ensureWorktreeRegistry(sql)).resolves.toBeUndefined();
});
