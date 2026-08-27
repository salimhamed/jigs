import postgres, {
  type ISql,
  type Options,
  type PostgresType,
  type Sql,
} from "postgres";

// The worktree registry holds state, never config: which run owns a worktree
// and what state it is in. Placement and bindings stay in jigs.yml. It lives
// in the same Postgres as the World; the table prefix keeps clear of the
// SDK's own tables. It holds live worktrees only — teardown deletes the row.
// States: active, provision-failed, abandoned-dirty.

export interface WorktreeRow {
  path: string;
  branch: string;
  ownerRunId: string;
  state: string;
  baseSha: string;
  headSha: string;
  behindDefault: number;
  checkoutRoot: string;
  keep: boolean;
}

// Single construction point: the camel transform is what lets queries return
// WorktreeRow-shaped rows straight from snake_case columns.
export function connectRegistry(
  url: string,
  options: Options<Record<string, PostgresType>> = {},
): Sql {
  return postgres(url, { transform: postgres.camel, ...options });
}

export async function ensureWorktreeRegistry(sql: ISql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS jigs_worktrees (
      path text PRIMARY KEY,
      branch text NOT NULL,
      owner_run_id text NOT NULL,
      state text NOT NULL,
      base_sha text NOT NULL,
      head_sha text NOT NULL,
      behind_default integer NOT NULL,
      checkout_root text NOT NULL DEFAULT '',
      keep boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // A dev database created before these columns existed upgrades in place —
  // two idempotent ALTERs beat introducing a migration tool for two columns.
  await sql`ALTER TABLE jigs_worktrees ADD COLUMN IF NOT EXISTS checkout_root text NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE jigs_worktrees ADD COLUMN IF NOT EXISTS keep boolean NOT NULL DEFAULT false`;
}

export async function getWorktree(
  sql: ISql,
  path: string,
): Promise<WorktreeRow | null> {
  const rows = await sql<WorktreeRow[]>`
    SELECT path, branch, owner_run_id, state, base_sha, head_sha,
           behind_default, checkout_root, keep
    FROM jigs_worktrees
    WHERE path = ${path}
  `;
  return rows[0] ?? null;
}

export async function listWorktrees(sql: ISql): Promise<WorktreeRow[]> {
  return sql<WorktreeRow[]>`
    SELECT path, branch, owner_run_id, state, base_sha, head_sha,
           behind_default, checkout_root, keep
    FROM jigs_worktrees
    ORDER BY updated_at DESC
  `;
}

export async function listWorktreesForRun(
  sql: ISql,
  runId: string,
): Promise<WorktreeRow[]> {
  return sql<WorktreeRow[]>`
    SELECT path, branch, owner_run_id, state, base_sha, head_sha,
           behind_default, checkout_root, keep
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
      (path, branch, owner_run_id, state, base_sha, head_sha, behind_default,
       checkout_root, keep)
    VALUES
      (${row.path}, ${row.branch}, ${row.ownerRunId}, ${row.state},
       ${row.baseSha}, ${row.headSha}, ${row.behindDefault},
       ${row.checkoutRoot}, ${row.keep})
    ON CONFLICT (path) DO UPDATE SET
      branch = EXCLUDED.branch,
      owner_run_id = EXCLUDED.owner_run_id,
      state = EXCLUDED.state,
      base_sha = EXCLUDED.base_sha,
      head_sha = EXCLUDED.head_sha,
      behind_default = EXCLUDED.behind_default,
      checkout_root = EXCLUDED.checkout_root,
      keep = EXCLUDED.keep,
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
