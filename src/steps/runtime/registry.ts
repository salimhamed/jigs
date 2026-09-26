import { fileURLToPath, pathToFileURL } from "node:url";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { Pool, type PoolConfig } from "pg";
import { factoryRoot } from "../../config/factory-root.ts";
import type { ResourceRecord, ResourceState } from "../../workflow/runtime/resources.ts";
import { factorySlug } from "../workspaces/layout.ts";

// Several factories may share one database, so every row names its factory and
// every query filters on it: a row here is this factory's proof of ownership.
export const resources = pgTable(
  "jigs_resources",
  {
    factory: text("factory").notNull(),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    identity: text("identity").notNull(),
    url: text("url").notNull(),
    state: text("state").$type<ResourceState>().notNull(),
    reason: text("reason"),
    /** Release attempts that failed since the row was last live. */
    attempts: integer("attempts").notNull().default(0),
    repoDir: text("repo_dir"),
    branch: text("branch"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.factory, table.runId, table.kind, table.identity] })],
);

export type ResourceRow = typeof resources.$inferSelect;
export type ResourceKey = Pick<ResourceRow, "factory" | "runId" | "kind" | "identity">;

export type RegistrySql = NodePgDatabase & { $client: Pool };

/** The factory slug rows are recorded under by the running service. */
export const currentFactory = (): string => factorySlug(factoryRoot());

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

// One lazily-opened connection for the process: the plugin's startup ensure,
// steps and automatic release all share it, so nothing ends a pool another
// caller still holds. The service owns process exit after World shutdown
// drains active work. CLI commands use their own pool.
let client: RegistrySql | undefined;

export function registrySql(): RegistrySql {
  if (client === undefined) {
    const url = process.env.WORKFLOW_POSTGRES_URL;
    if (url === undefined || url === "") {
      throw new Error("WORKFLOW_POSTGRES_URL is not set");
    }
    client = connectRegistry(url);
  }
  return client;
}

export async function ensureRegistry(db: RegistrySql): Promise<void> {
  // Resolve the installed package, not the service chunk Nitro may inline us
  // into. The SQL and journal ship beside dist/, also when installed by pnpm.
  const migrationsFolder = fileURLToPath(
    new URL("../migrations/", import.meta.resolve("@jigs-ai/jigs")),
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
    await ensureRegistry(db);
  } finally {
    await db.$client.end();
  }
}

/** Insert or refresh a row as live; kind-specific columns are kept unless given. */
export async function recordResource(
  db: RegistrySql,
  row: ResourceKey & Pick<ResourceRow, "url"> & Partial<Pick<ResourceRow, "repoDir" | "branch">>,
): Promise<void> {
  const refreshed = {
    url: row.url,
    state: "live" as const,
    reason: null,
    attempts: 0,
    ...(row.repoDir === undefined ? {} : { repoDir: row.repoDir }),
    ...(row.branch === undefined ? {} : { branch: row.branch }),
  };
  await db
    .insert(resources)
    .values({ ...row, ...refreshed })
    .onConflictDoUpdate({
      target: [resources.factory, resources.runId, resources.kind, resources.identity],
      set: { ...refreshed, updatedAt: sql`now()` },
    });
}

/** Record a directory jigs keeps for one run, named by the run ID, on the service's pool. */
export async function recordRunDirectory(
  kind: string,
  runId: string,
  directory: string,
): Promise<void> {
  await recordResource(registrySql(), {
    factory: currentFactory(),
    runId,
    kind,
    identity: runId,
    url: pathToFileURL(directory).href,
  });
}

export async function setResourceState(
  db: RegistrySql,
  key: ResourceKey,
  state: ResourceState,
  reason: string | null,
  attempts?: number,
): Promise<void> {
  await db
    .update(resources)
    .set({ state, reason, ...(attempts === undefined ? {} : { attempts }), updatedAt: sql`now()` })
    .where(
      and(
        eq(resources.factory, key.factory),
        eq(resources.runId, key.runId),
        eq(resources.kind, key.kind),
        eq(resources.identity, key.identity),
      ),
    );
}

export interface ResourceFilter {
  factory: string;
  runId?: string;
  runIds?: readonly string[];
  kind?: string;
  kinds?: readonly string[];
  identity?: string;
  states?: readonly ResourceState[];
}

export async function listResources(
  db: RegistrySql,
  filter: ResourceFilter,
): Promise<ResourceRow[]> {
  return db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.factory, filter.factory),
        filter.runId === undefined ? undefined : eq(resources.runId, filter.runId),
        // One array parameter, not one per run: Postgres caps a query at 65,535.
        filter.runIds === undefined
          ? undefined
          : sql`${resources.runId} = any(${sql.param([...filter.runIds])}::text[])`,
        filter.kind === undefined ? undefined : eq(resources.kind, filter.kind),
        filter.kinds === undefined ? undefined : inArray(resources.kind, [...filter.kinds]),
        filter.identity === undefined ? undefined : eq(resources.identity, filter.identity),
        filter.states === undefined ? undefined : inArray(resources.state, [...filter.states]),
      ),
    )
    .orderBy(asc(resources.runId), asc(resources.createdAt), asc(resources.kind));
}

export const toRecord = (row: ResourceRow): ResourceRecord => ({
  runId: row.runId,
  kind: row.kind,
  identity: row.identity,
  url: row.url,
  state: row.state,
  reason: row.reason,
  updatedAt: row.updatedAt.toISOString(),
});

/** Serialize provisioning, release and prune of one run's resources across processes. */
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
    // Session locks end with the session, so a connection that cannot unlock
    // is destroyed rather than returned to the pool still holding them.
    await client.query("select pg_advisory_unlock_all()").then(
      () => client.release(),
      (error: Error) => client.release(error),
    );
  }
}

/**
 * Also hold another run's lock on a connection {@link withRunResourceLock} gave out, until that
 * outer lock ends. Only a run that is finished may be locked this way, so nothing waits in reverse.
 */
export async function alsoLockRun(locked: RegistrySql, runId: string): Promise<void> {
  await locked.$client.query("select pg_advisory_lock(hashtextextended($1, 464))", [runId]);
}
