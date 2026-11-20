// The versions a factory has run and which one is current (ADR 0019). A row
// is one deployment version; `current` marks the one that is the factory,
// written only by `jigs deployments current`.

import { and, eq, ne, sql } from "drizzle-orm";
import { boolean, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { DEFAULT_JOB_PREFIX, deploymentJobPrefix } from "../../config/deployment-version.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";

// Keyed by factory like jigs_resources: several factories may share one database.
export const deployments = pgTable(
  "jigs_deployments",
  {
    factory: text("factory").notNull(),
    version: text("version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    // Refreshed by the running copy's heartbeat; null while no copy of the version has run.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // The running copy's process; null once it has shut down.
    pid: integer("pid"),
    host: text("host"),
    current: boolean("current").notNull().default(false),
    madeCurrentAt: timestamp("made_current_at", { withTimezone: true }),
    // When another version was last made current over this one: the start of
    // its drain, which the drain cap counts from. Null while it is current.
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.factory, table.version] })],
);

export type DeploymentRow = typeof deployments.$inferSelect;

/** The Postgres channel `jigs deployments current` notifies on; the payload is the factory slug. */
export const DEPLOYMENTS_CHANNEL = "jigs_deployments";

/**
 * How long after its last heartbeat a version's process still counts as running: long enough
 * that a database blip does not show a live version as gone, where prune may forget it.
 */
export const LIVE_WINDOW_MS = 5 * 60_000;

/** How often a running copy refreshes its heartbeat. */
export const HEARTBEAT_MS = 15_000;

export interface DeploymentProcess {
  pid: number;
  host: string;
}

/** A copy of `version` has booted: start its clock and its heartbeat. */
export async function recordDeploymentBoot(
  db: RegistrySql,
  factory: string,
  version: string,
  process: DeploymentProcess,
): Promise<void> {
  const seen = { lastSeenAt: sql`now()`, pid: process.pid, host: process.host };
  await db
    .insert(deployments)
    .values({ factory, version, ...seen })
    .onConflictDoUpdate({
      target: [deployments.factory, deployments.version],
      set: { ...seen, startedAt: sql`now()`, updatedAt: sql`now()` },
    });
}

/** Refresh a running copy's heartbeat, and claim the row for its process. */
export async function touchDeployment(
  db: RegistrySql,
  factory: string,
  version: string,
  process: DeploymentProcess,
): Promise<void> {
  await db
    .update(deployments)
    .set({ lastSeenAt: sql`now()`, pid: process.pid, host: process.host, updatedAt: sql`now()` })
    .where(and(eq(deployments.factory, factory), eq(deployments.version, version)));
}

/**
 * A copy of `version` has shut down: it no longer counts as running. A row another copy of the
 * same version has claimed since is left alone.
 */
export async function recordDeploymentStop(
  db: RegistrySql,
  factory: string,
  version: string,
  process: DeploymentProcess,
): Promise<void> {
  await db
    .update(deployments)
    .set({ pid: null, host: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(deployments.factory, factory),
        eq(deployments.version, version),
        eq(deployments.pid, process.pid),
        eq(deployments.host, process.host),
      ),
    );
}

/** The factory's current version, or null while none has been made current. */
export async function currentDeployment(db: RegistrySql, factory: string): Promise<string | null> {
  const rows = await db
    .select({ version: deployments.version })
    .from(deployments)
    .where(and(eq(deployments.factory, factory), eq(deployments.current, true)));
  return rows[0]?.version ?? null;
}

/**
 * Make `version` the factory's current version, creating its row when no copy of it has booted
 * yet, and tell every listening copy. Returns the version that was current before, if any.
 */
export async function makeDeploymentCurrent(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const previous = await currentDeployment(tx as unknown as RegistrySql, factory);
    await tx
      .update(deployments)
      .set({ current: false, supersededAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(deployments.factory, factory),
          eq(deployments.current, true),
          ne(deployments.version, version),
        ),
      );
    const madeCurrent = { current: true, madeCurrentAt: sql`now()`, supersededAt: null };
    await tx
      .insert(deployments)
      .values({ factory, version, ...madeCurrent })
      .onConflictDoUpdate({
        target: [deployments.factory, deployments.version],
        set: { ...madeCurrent, updatedAt: sql`now()` },
      });
    await tx.execute(sql`select pg_notify(${DEPLOYMENTS_CHANNEL}, ${factory})`);
    return previous;
  });
}

/** Whether `version` has ever been the factory's current version. */
export async function wasEverCurrent(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<boolean> {
  const rows = await db
    .select({ madeCurrentAt: deployments.madeCurrentAt })
    .from(deployments)
    .where(and(eq(deployments.factory, factory), eq(deployments.version, version)));
  return rows[0]?.madeCurrentAt != null;
}

/** Whether a process of `version` is up and has reported recently enough to count as running. */
export async function deploymentRunning(
  db: RegistrySql,
  factory: string,
  version: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .select({ lastSeenAt: deployments.lastSeenAt, pid: deployments.pid })
    .from(deployments)
    .where(and(eq(deployments.factory, factory), eq(deployments.version, version)));
  const row = rows[0];
  return row !== undefined && processRunning(row, now);
}

/** When `version` stopped being current, or null while it is current or never was. */
export async function drainingSince(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<Date | null> {
  const rows = await db
    .select({ supersededAt: deployments.supersededAt })
    .from(deployments)
    .where(and(eq(deployments.factory, factory), eq(deployments.version, version)));
  return rows[0]?.supersededAt ?? null;
}

export type DeploymentRole = "current" | "draining" | "gone";

/** One version as `jigs deployments` and `GET /api/deployments` show it. */
export interface DeploymentView {
  version: string;
  role: DeploymentRole;
  startedAt: string;
  lastSeenAt: string | null;
  madeCurrentAt: string | null;
  supersededAt: string | null;
  pid: number | null;
  host: string | null;
  /** Whether a process of this version is up and has reported within the last five minutes. */
  running: boolean;
  /** The live runs this version started; they finish on it. */
  runs: number;
}

/** Whether a heartbeat this old still counts as a running process. */
export function seenRecently(lastSeenAt: Date | null, now: Date): boolean {
  return lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < LIVE_WINDOW_MS;
}

/** Whether the row's process has not shut down and its heartbeat still counts. */
export function processRunning(row: Pick<DeploymentRow, "lastSeenAt" | "pid">, now: Date): boolean {
  return row.pid !== null && seenRecently(row.lastSeenAt, now);
}

export function roleOf(
  row: Pick<DeploymentRow, "current" | "lastSeenAt" | "pid">,
  now: Date,
): DeploymentRole {
  if (row.current) return "current";
  return processRunning(row, now) ? "draining" : "gone";
}

/** Every version the factory has run, newest start first, with the runs each still owns. */
export async function listDeployments(
  db: RegistrySql,
  factory: string,
  jobPrefix: string = DEFAULT_JOB_PREFIX,
  now: Date = new Date(),
): Promise<DeploymentView[]> {
  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.factory, factory))
    .orderBy(sql`${deployments.startedAt} desc`);
  const owned = await ownedRunCounts(db);
  return rows.map((row) => ({
    version: row.version,
    role: roleOf(row, now),
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    madeCurrentAt: row.madeCurrentAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    pid: row.pid,
    host: row.host,
    running: processRunning(row, now),
    runs: owned.get(deploymentJobPrefix(jobPrefix, row.version)) ?? 0,
  }));
}

/** Whether a row of the World's `workflow_runs`, aliased `r`, is a run that has not ended. */
export const LIVE_RUN = sql`r.status in ('pending', 'running')`;

// The World's own table: a run's `job_prefix` names the deployment that started it.
async function ownedRunCounts(db: RegistrySql): Promise<Map<string, number>> {
  const { rows } = await db.execute<{ jobPrefix: string; runs: number }>(sql`
    select r.job_prefix as "jobPrefix", count(*)::int as runs
    from "workflow"."workflow_runs" r
    where ${LIVE_RUN} and r.job_prefix is not null
    group by r.job_prefix
  `);
  return new Map(rows.map((row) => [row.jobPrefix, row.runs]));
}

/** Remove every version that is not current, owns no run and has no running process. */
export async function pruneDeployments(
  db: RegistrySql,
  factory: string,
  jobPrefix: string = DEFAULT_JOB_PREFIX,
  now: Date = new Date(),
): Promise<string[]> {
  const listed = await listDeployments(db, factory, jobPrefix, now);
  const removable = listed.filter((view) => view.role === "gone" && view.runs === 0);
  for (const view of removable) {
    await db
      .delete(deployments)
      .where(and(eq(deployments.factory, factory), eq(deployments.version, view.version)));
  }
  return removable.map((view) => view.version);
}
