import { afterAll, expect, test } from "vitest";
import {
  connectRegistry,
  ensureWorktreeRegistry,
  getWorktree,
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
