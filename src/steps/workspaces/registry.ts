import { fileURLToPath } from "node:url";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolConfig } from "pg";
import { worktrees } from "./schema.ts";

// Live worktrees only: bindings remain factory configuration and teardown
// deletes the row. Column names are mapped by the schema, not by the driver.
export interface WorktreeRow {
  path: string;
  branch: string;
  ownerRunId: string;
  state: string;
  repoDir: string;
}

export type RegistrySql = NodePgDatabase & { $client: Pool };

/** The caller owns this pool; registrySql() owns the shared process pool. */
export function connectRegistry(url: string, options: PoolConfig = {}): RegistrySql {
  const pool = new Pool({ ...options, connectionString: url });
  // pg removes failed idle clients itself. Listen so a lost idle connection
  // is reported instead of becoming an unhandled error that kills the service.
  pool.on("error", (error) => {
    console.error(`[registry] idle PostgreSQL connection failed: ${error.message}`);
  });
  return drizzle(pool);
}

export async function ensureWorktreeRegistry(db: RegistrySql): Promise<void> {
  // Resolve the installed package, not the service chunk Nitro may inline us
  // into. The SQL and journal ship beside dist/, also when installed by pnpm.
  const migrationsFolder = fileURLToPath(
    new URL("../migrations/", import.meta.resolve("@salimhamed/jigs")),
  );
  await migrate(db, {
    migrationsFolder,
    migrationsTable: "jigs_migrations",
    migrationsSchema: "jigs_drizzle",
  });
}

/** CLI bootstrap owns a short-lived pool; never end the service's shared pool. */
export async function migrateRegistry(url: string): Promise<void> {
  const db = connectRegistry(url, { max: 1 });
  try {
    await ensureWorktreeRegistry(db);
  } finally {
    await db.$client.end();
  }
}

const fields = {
  path: worktrees.path,
  branch: worktrees.branch,
  ownerRunId: worktrees.ownerRunId,
  state: worktrees.state,
  repoDir: worktrees.repoDir,
};

export async function getWorktree(db: RegistrySql, path: string): Promise<WorktreeRow | null> {
  const rows = await db.select(fields).from(worktrees).where(eq(worktrees.path, path));
  return rows[0] ?? null;
}

export async function listWorktrees(db: RegistrySql): Promise<WorktreeRow[]> {
  return db.select(fields).from(worktrees).orderBy(desc(worktrees.updatedAt));
}

export async function listWorktreesForRun(db: RegistrySql, runId: string): Promise<WorktreeRow[]> {
  return db
    .select(fields)
    .from(worktrees)
    .where(eq(worktrees.ownerRunId, runId))
    .orderBy(desc(worktrees.updatedAt));
}

export async function upsertWorktree(db: RegistrySql, row: WorktreeRow): Promise<void> {
  await db
    .insert(worktrees)
    .values(row)
    .onConflictDoUpdate({
      target: worktrees.path,
      set: {
        branch: row.branch,
        ownerRunId: row.ownerRunId,
        state: row.state,
        repoDir: row.repoDir,
        updatedAt: sql`now()`,
      },
    });
}

export async function setWorktreeState(
  db: RegistrySql,
  path: string,
  state: string,
): Promise<void> {
  await db.update(worktrees).set({ state, updatedAt: sql`now()` }).where(eq(worktrees.path, path));
}

export async function deleteWorktree(db: RegistrySql, path: string): Promise<void> {
  await db.delete(worktrees).where(eq(worktrees.path, path));
}

/** Serialize managed-state mutations for one run across service processes. */
export async function withRunResourceLock<T>(
  db: RegistrySql,
  runId: string,
  action: (locked: RegistrySql) => Promise<T>,
): Promise<T> {
  const client = await db.$client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 464))", [runId]);
    return await action(drizzle(client) as unknown as RegistrySql);
  } finally {
    try {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 464))", [runId]);
    } finally {
      client.release();
    }
  }
}
