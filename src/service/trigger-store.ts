// The event triggers' record of every occurrence they saw, and where each
// trigger's polling has got to. The row, not the provider, is the dedupe
// record: a run that decides to do nothing leaves no trace anywhere else.

import { and, asc, count, desc, eq, gt, isNotNull, isNull, max, sql } from "drizzle-orm";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { CheckReport } from "../checks/index.ts";
import type { RegistrySql } from "../steps/runtime/registry.ts";

export type OccurrenceState = "pending" | "started" | "failed" | "skipped";

// Keyed by factory like jigs_resources: several factories may share one
// database, and every query filters on the factory.
export const occurrences = pgTable(
  "jigs_triggers",
  {
    factory: text("factory").notNull(),
    trigger: text("trigger").notNull(),
    occurrence: text("occurrence").notNull(),
    state: text("state").$type<OccurrenceState>().notNull(),
    // The source's reference, kept so a row that waits past a restart or the
    // cap starts with what it was seen with. Fixed inputs are merged at start.
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // Set just before each start: from the first the row holds a slot, and
    // its run is looked up by its occurrence attribute from the latest.
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    // A start that threw may still have created or queued its run, so the
    // row stays uncertain, holding its slot, until a lookup settles it.
    startFailedAt: timestamp("start_failed_at", { withTimezone: true }),
    // Runs the engine cancelled after a failed start: never this row's run.
    cancelledRunIds: jsonb("cancelled_run_ids").$type<string[]>(),
    runId: text("run_id"),
    // When the engine saw the started run finish, so the cap stops asking.
    settledAt: timestamp("settled_at", { withTimezone: true }),
    // Only a start after its lookup found nothing can race a run the SDK had
    // queued but not recorded: until this time, drains look for a second one.
    duplicateCheckSince: timestamp("duplicate_check_since", { withTimezone: true }),
    duplicateCheckUntil: timestamp("duplicate_check_until", { withTimezone: true }),
    duplicateRunIds: jsonb("duplicate_run_ids").$type<string[]>(),
    report: jsonb("report").$type<CheckReport>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.factory, table.trigger, table.occurrence] })],
);

export const markers = pgTable(
  "jigs_trigger_markers",
  {
    factory: text("factory").notNull(),
    trigger: text("trigger").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull(),
    polledThrough: timestamp("polled_through", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.factory, table.trigger] })],
);

export interface Occurrence {
  trigger: string;
  occurrence: string;
  state: OccurrenceState;
  inputs: Record<string, unknown>;
  occurredAt: Date;
  attemptedAt: Date | null;
  startFailedAt: Date | null;
  cancelledRunIds: string[] | null;
  runId: string | null;
  settledAt: Date | null;
  duplicateCheckSince: Date | null;
  duplicateCheckUntil: Date | null;
  duplicateRunIds: string[] | null;
  report: CheckReport | null;
  updatedAt: Date;
}

export interface TriggerMarker {
  enabledAt: Date;
  polledThrough: Date;
}

export interface TriggerSummary {
  lastEvent: Date | null;
  /** Pending rows not yet attempted. */
  pending: number;
  /** Pending rows whose start was attempted: each holds a slot. */
  attempted: number;
  failed: number;
  /** The most recent failed rows, newest first. */
  failures: Occurrence[];
  /** Rows with more than one run for their occurrence. */
  duplicates: Array<Pick<Occurrence, "occurrence" | "runId"> & { runIds: string[] }>;
}

/** What the trigger engine reads and writes, over one factory's rows. */
export interface TriggerStore {
  /** The trigger's marker, written as `now` the first time it is asked for. */
  enable(trigger: string, now: Date): Promise<TriggerMarker>;
  advance(trigger: string, polledThrough: Date): Promise<void>;
  /** Insert the row unless the occurrence is already recorded; true when it was new. */
  record(
    row: Pick<Occurrence, "trigger" | "occurrence" | "state" | "inputs" | "occurredAt">,
  ): Promise<boolean>;
  /** Oldest occurrence first. */
  pending(trigger: string): Promise<Occurrence[]>;
  /** Mark a pending row as about to start now, clearing a failed start before it. */
  attempt(trigger: string, occurrence: string, at: Date): Promise<void>;
  startFailed(trigger: string, occurrence: string, at: Date): Promise<void>;
  cancelledRun(trigger: string, occurrence: string, runId: string): Promise<void>;
  /** Look for a second run of this occurrence, minted since then, until the second time. */
  watchForDuplicate(trigger: string, occurrence: string, since: Date, until: Date): Promise<void>;
  /** Rows still watched for a second run at this time, whatever their state. */
  watched(trigger: string, now: Date): Promise<Occurrence[]>;
  /** Record the runs found for one occurrence, and stop watching it. */
  duplicated(trigger: string, occurrence: string, runIds: string[]): Promise<void>;
  /** Clear a recorded duplicate, keeping the run that is left, if any. */
  undupe(trigger: string, occurrence: string, survivor: string | null): Promise<void>;
  /** Started rows whose run has not been seen to finish, with when they started. */
  unsettled(trigger: string): Promise<Array<Occurrence & { startedAt: Date }>>;
  settle(trigger: string, occurrence: string): Promise<void>;
  started(trigger: string, occurrence: string, runId: string): Promise<void>;
  failed(trigger: string, occurrence: string, report: CheckReport): Promise<void>;
  summary(trigger: string, failures: number): Promise<TriggerSummary>;
}

export function triggerStore(db: RegistrySql, factory: string): TriggerStore {
  const row = (trigger: string, occurrence: string) =>
    and(
      eq(occurrences.factory, factory),
      eq(occurrences.trigger, trigger),
      eq(occurrences.occurrence, occurrence),
    );
  const ofTrigger = (trigger: string) =>
    and(eq(occurrences.factory, factory), eq(occurrences.trigger, trigger));
  // Only a pending row moves: a second writer can never turn a started row
  // back into a failed one, or restart it.
  const settle = async (
    trigger: string,
    occurrence: string,
    set: Pick<Occurrence, "state"> & Partial<Pick<Occurrence, "runId" | "report">>,
  ) => {
    await db
      .update(occurrences)
      .set({ ...set, updatedAt: sql`now()` })
      .where(and(row(trigger, occurrence), eq(occurrences.state, "pending")));
  };

  return {
    async enable(trigger, now) {
      await db
        .insert(markers)
        .values({ factory, trigger, enabledAt: now, polledThrough: now })
        .onConflictDoNothing();
      const [marker] = await db
        .select({ enabledAt: markers.enabledAt, polledThrough: markers.polledThrough })
        .from(markers)
        .where(and(eq(markers.factory, factory), eq(markers.trigger, trigger)));
      if (marker === undefined) throw new Error(`trigger ${trigger} has no marker after enabling`);
      return marker;
    },
    async advance(trigger, polledThrough) {
      await db
        .update(markers)
        .set({ polledThrough })
        .where(and(eq(markers.factory, factory), eq(markers.trigger, trigger)));
    },
    async record(occurrence) {
      const inserted = await db
        .insert(occurrences)
        .values({ factory, ...occurrence })
        .onConflictDoNothing()
        .returning({ occurrence: occurrences.occurrence });
      return inserted.length > 0;
    },
    async pending(trigger) {
      return db
        .select()
        .from(occurrences)
        .where(and(ofTrigger(trigger), eq(occurrences.state, "pending")))
        .orderBy(asc(occurrences.occurredAt), asc(occurrences.createdAt));
    },
    async attempt(trigger, occurrence, at) {
      const updated = await db
        .update(occurrences)
        .set({ attemptedAt: at, startFailedAt: null, updatedAt: sql`now()` })
        .where(and(row(trigger, occurrence), eq(occurrences.state, "pending")))
        .returning({ occurrence: occurrences.occurrence });
      if (updated.length === 0) throw new Error(`${trigger} ${occurrence} is no longer pending`);
    },
    async startFailed(trigger, occurrence, at) {
      await db
        .update(occurrences)
        .set({ startFailedAt: at, updatedAt: sql`now()` })
        .where(and(row(trigger, occurrence), eq(occurrences.state, "pending")));
    },
    async cancelledRun(trigger, occurrence, runId) {
      await db
        .update(occurrences)
        .set({
          cancelledRunIds: sql`coalesce(${occurrences.cancelledRunIds}, '[]'::jsonb) || ${JSON.stringify([runId])}::jsonb`,
        })
        .where(row(trigger, occurrence));
    },
    async watchForDuplicate(trigger, occurrence, since, until) {
      await db
        .update(occurrences)
        .set({ duplicateCheckSince: since, duplicateCheckUntil: until })
        .where(row(trigger, occurrence));
    },
    async watched(trigger, now) {
      return db
        .select()
        .from(occurrences)
        .where(and(ofTrigger(trigger), gt(occurrences.duplicateCheckUntil, now)));
    },
    async duplicated(trigger, occurrence, runIds) {
      await db
        .update(occurrences)
        .set({ duplicateRunIds: runIds, duplicateCheckUntil: null })
        .where(row(trigger, occurrence));
    },
    async undupe(trigger, occurrence, survivor) {
      await db
        .update(occurrences)
        .set({
          duplicateRunIds: null,
          ...(survivor === null ? {} : { runId: survivor }),
        })
        .where(row(trigger, occurrence));
    },
    async unsettled(trigger) {
      // Nothing touches a started row's updated_at but its start.
      const rows = await db
        .select()
        .from(occurrences)
        .where(
          and(ofTrigger(trigger), eq(occurrences.state, "started"), isNull(occurrences.settledAt)),
        );
      return rows.map((started) => ({ ...started, startedAt: started.updatedAt }));
    },
    async settle(trigger, occurrence) {
      await db
        .update(occurrences)
        .set({ settledAt: sql`now()` })
        .where(and(row(trigger, occurrence), eq(occurrences.state, "started")));
    },
    started: (trigger, occurrence, runId) =>
      settle(trigger, occurrence, { state: "started", runId }),
    failed: (trigger, occurrence, report) =>
      settle(trigger, occurrence, { state: "failed", report }),
    async summary(trigger, failures) {
      const counts = await db
        .select({ state: occurrences.state, rows: count(), last: max(occurrences.occurredAt) })
        .from(occurrences)
        .where(ofTrigger(trigger))
        .groupBy(occurrences.state);
      const [attempted] = await db
        .select({ rows: count() })
        .from(occurrences)
        .where(
          and(
            ofTrigger(trigger),
            eq(occurrences.state, "pending"),
            isNotNull(occurrences.attemptedAt),
          ),
        );
      const recent = await db
        .select()
        .from(occurrences)
        .where(and(ofTrigger(trigger), eq(occurrences.state, "failed")))
        .orderBy(desc(occurrences.updatedAt))
        .limit(failures);
      const duplicates = await db
        .select({
          occurrence: occurrences.occurrence,
          runId: occurrences.runId,
          runIds: occurrences.duplicateRunIds,
        })
        .from(occurrences)
        .where(and(ofTrigger(trigger), isNotNull(occurrences.duplicateRunIds)));
      const rows = (state: OccurrenceState) => counts.find((c) => c.state === state)?.rows ?? 0;
      const lasts = counts.flatMap((c) => (c.last === null ? [] : [c.last.getTime()]));
      return {
        lastEvent: lasts.length === 0 ? null : new Date(Math.max(...lasts)),
        pending: rows("pending") - (attempted?.rows ?? 0),
        attempted: attempted?.rows ?? 0,
        failed: rows("failed"),
        failures: recent,
        duplicates: duplicates.map((dup) => ({
          occurrence: dup.occurrence,
          runId: dup.runId,
          runIds: dup.runIds ?? [],
        })),
      };
    },
  };
}
