import postgres, { type Sql } from "postgres";

// The worktree registry holds state, never config: which run owns a worktree
// and what state it is in. Placement and bindings stay in jigs.yml. It lives
// in the same Postgres as the World; the table prefix keeps clear of the
// SDK's own tables.

export interface WorktreeRow {
  path: string;
  branch: string;
  ownerRunId: string;
  state: string;
  baseSha: string;
  headSha: string;
  behindDefault: number;
}

interface DbRow {
  path: string;
  branch: string;
  owner_run_id: string;
  state: string;
  base_sha: string;
  head_sha: string;
  behind_default: number;
}

function toWorktreeRow(db: DbRow): WorktreeRow {
  return {
    path: db.path,
    branch: db.branch,
    ownerRunId: db.owner_run_id,
    state: db.state,
    baseSha: db.base_sha,
    headSha: db.head_sha,
    behindDefault: db.behind_default,
  };
}

let singleton: Sql | undefined;

export function registrySql(): Sql {
  if (singleton === undefined) {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    if (url === undefined) {
      throw new Error(
        "WORKFLOW_POSTGRES_URL is not set — the worktree registry lives in the service's Postgres",
      );
    }
    singleton = postgres(url);
  }
  return singleton;
}

export async function ensureWorktreeRegistry(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS jigs_worktrees (
      path text PRIMARY KEY,
      branch text NOT NULL,
      owner_run_id text NOT NULL,
      state text NOT NULL,
      base_sha text NOT NULL,
      head_sha text NOT NULL,
      behind_default integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

export async function getWorktree(
  sql: Sql,
  path: string,
): Promise<WorktreeRow | null> {
  const rows = await sql<DbRow[]>`
    SELECT path, branch, owner_run_id, state, base_sha, head_sha, behind_default
    FROM jigs_worktrees
    WHERE path = ${path}
  `;
  const row = rows[0];
  return row === undefined ? null : toWorktreeRow(row);
}

export async function upsertWorktree(
  sql: Sql,
  row: WorktreeRow,
): Promise<void> {
  await sql`
    INSERT INTO jigs_worktrees
      (path, branch, owner_run_id, state, base_sha, head_sha, behind_default)
    VALUES
      (${row.path}, ${row.branch}, ${row.ownerRunId}, ${row.state},
       ${row.baseSha}, ${row.headSha}, ${row.behindDefault})
    ON CONFLICT (path) DO UPDATE SET
      branch = EXCLUDED.branch,
      owner_run_id = EXCLUDED.owner_run_id,
      state = EXCLUDED.state,
      base_sha = EXCLUDED.base_sha,
      head_sha = EXCLUDED.head_sha,
      behind_default = EXCLUDED.behind_default,
      updated_at = now()
  `;
}

// The sweep/ps query shape: every worktree the runtime ever made.
export async function listWorktrees(sql: Sql): Promise<WorktreeRow[]> {
  const rows = await sql<DbRow[]>`
    SELECT path, branch, owner_run_id, state, base_sha, head_sha, behind_default
    FROM jigs_worktrees
    ORDER BY path
  `;
  return rows.map(toWorktreeRow);
}
