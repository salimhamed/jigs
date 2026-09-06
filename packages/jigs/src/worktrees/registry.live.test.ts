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
} from "./registry.ts";

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
    repoDir: "/data/bindings/acme-abc12345/api/repo.git",
    ...overrides,
  };
}

test("ensureWorktreeRegistry is idempotent", async () => {
  await ensureWorktreeRegistry(sql);
  await expect(ensureWorktreeRegistry(sql)).resolves.toBeUndefined();
});

test("upsert inserts a row carrying its owner and state", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  expect(await getWorktree(sql, testPath)).toEqual(row());
});

test("re-upsert with a new owner updates the row in place", async () => {
  await ensureWorktreeRegistry(sql);
  await upsertWorktree(sql, row());
  await upsertWorktree(sql, row({ ownerRunId: "run_b", branch: "feat-2" }));
  expect(await getWorktree(sql, testPath)).toEqual(
    row({ ownerRunId: "run_b", branch: "feat-2" }),
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
  repo_dir text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()`;

// Drops the real table and rebuilds it in an older shape, asserts the probe
// refuses it naming the drop, then restores the current shape so a filtered
// run of this file leaves the dev database as it found it.
async function expectRefused(columns: string, message: RegExp): Promise<void> {
  await sql`DROP TABLE IF EXISTS jigs_worktrees`;
  await sql.unsafe(`CREATE TABLE jigs_worktrees (${columns})`);
  await expect(ensureWorktreeRegistry(sql)).rejects.toThrow(message);

  await sql`DROP TABLE jigs_worktrees`;
  await expect(ensureWorktreeRegistry(sql)).resolves.toBeUndefined();
}

function replacing(from: string, to: string): string {
  if (!CURRENT_COLUMNS.includes(from)) throw new Error(`no ${from} to replace`);
  return CURRENT_COLUMNS.replace(from, to);
}

test("a table that predates repo_dir is refused, naming the drop", async () => {
  await expectRefused(
    replacing(
      "repo_dir text NOT NULL",
      "checkout_root text NOT NULL DEFAULT ''",
    ),
    /missing repo_dir.*DROP TABLE jigs_worktrees/s,
  );
});

test("a table that still carries a retired column is refused, naming the drop", async () => {
  await expectRefused(
    replacing(
      "repo_dir text NOT NULL,",
      "repo_dir text NOT NULL,\n  keep boolean NOT NULL DEFAULT false,",
    ),
    /unexpected keep.*DROP TABLE jigs_worktrees/s,
  );
});

test("a table that still carries the sha triple is refused, naming the drop", async () => {
  await expectRefused(
    replacing(
      "state text NOT NULL,",
      "state text NOT NULL,\n  base_sha text NOT NULL,\n  head_sha text NOT NULL,\n  behind_default integer NOT NULL,",
    ),
    /unexpected base_sha, head_sha, behind_default.*DROP TABLE jigs_worktrees/s,
  );
});
