import postgres, {
  type ISql,
  type Options,
  type PostgresType,
  type Sql,
} from "postgres";

// The worktree registry holds state, never config: which run owns a worktree
// and what state it is in. Bindings stay in jigs.yml. It lives in the same
// Postgres as the World; the table prefix keeps clear of the SDK's own tables.
// It holds live worktrees only — teardown deletes the row. States: active,
// provision-failed, abandoned-dirty.

export interface WorktreeRow {
  path: string;
  branch: string;
  ownerRunId: string;
  state: string;
  repoDir: string;
}

// Single construction point: the camel transform is what lets queries return
// WorktreeRow-shaped rows straight from snake_case columns.
export function connectRegistry(
  url: string,
  options: Options<Record<string, PostgresType>> = {},
): Sql {
  return postgres(url, { transform: postgres.camel, ...options });
}

const REGISTRY_COLUMNS = [
  "path",
  "branch",
  "owner_run_id",
  "state",
  "repo_dir",
  "created_at",
  "updated_at",
];

export async function ensureWorktreeRegistry(sql: ISql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS jigs_worktrees (
      path text PRIMARY KEY,
      branch text NOT NULL,
      owner_run_id text NOT NULL,
      state text NOT NULL,
      repo_dir text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // CREATE TABLE IF NOT EXISTS is silent about a table of an older shape, and
  // every query would then fail one layer deeper, mid-run.
  const columns = await sql<{ columnName: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'jigs_worktrees'
  `;
  const actual = new Set(columns.map((column) => column.columnName));
  const missing = REGISTRY_COLUMNS.filter((column) => !actual.has(column));
  const extra = [...actual].filter(
    (column) => !REGISTRY_COLUMNS.includes(column),
  );
  if (missing.length > 0 || extra.length > 0) {
    const diff = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : null,
      extra.length > 0 ? `unexpected ${extra.join(", ")}` : null,
    ]
      .filter((part) => part !== null)
      .join("; ");
    throw new Error(
      `jigs_worktrees has an older shape (${diff}), so the service refuses ` +
        "to start. The registry holds live worktrees only and start recreates " +
        "it, so the repair is to drop it: " +
        "psql \"$WORKFLOW_POSTGRES_URL\" -c 'DROP TABLE jigs_worktrees'",
    );
  }
}

export async function getWorktree(
  sql: ISql,
  path: string,
): Promise<WorktreeRow | null> {
  const rows = await sql<WorktreeRow[]>`
    SELECT path, branch, owner_run_id, state, repo_dir
    FROM jigs_worktrees
    WHERE path = ${path}
  `;
  return rows[0] ?? null;
}

export async function listWorktrees(sql: ISql): Promise<WorktreeRow[]> {
  return sql<WorktreeRow[]>`
    SELECT path, branch, owner_run_id, state, repo_dir
    FROM jigs_worktrees
    ORDER BY updated_at DESC
  `;
}

export async function listWorktreesForRun(
  sql: ISql,
  runId: string,
): Promise<WorktreeRow[]> {
  return sql<WorktreeRow[]>`
    SELECT path, branch, owner_run_id, state, repo_dir
    FROM jigs_worktrees
    WHERE owner_run_id = ${runId}
    ORDER BY updated_at DESC
  `;
}

export async function upsertWorktree(
  sql: ISql,
  row: WorktreeRow,
): Promise<void> {
  await sql`
    INSERT INTO jigs_worktrees
      (path, branch, owner_run_id, state, repo_dir)
    VALUES
      (${row.path}, ${row.branch}, ${row.ownerRunId}, ${row.state},
       ${row.repoDir})
    ON CONFLICT (path) DO UPDATE SET
      branch = EXCLUDED.branch,
      owner_run_id = EXCLUDED.owner_run_id,
      state = EXCLUDED.state,
      repo_dir = EXCLUDED.repo_dir,
      updated_at = now()
  `;
}

export async function setWorktreeState(
  sql: ISql,
  path: string,
  state: string,
): Promise<void> {
  await sql`
    UPDATE jigs_worktrees SET state = ${state}, updated_at = now()
    WHERE path = ${path}
  `;
}

export async function deleteWorktree(sql: ISql, path: string): Promise<void> {
  await sql`DELETE FROM jigs_worktrees WHERE path = ${path}`;
}
