// The event triggers' record of every occurrence they saw, and where each
// trigger's polling has got to. The row, not the provider, is the dedupe
// record: a run that decides to do nothing leaves no trace anywhere else.

import { and, asc, count, desc, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm";
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
    // The value every run of this occurrence carries as its occurrence
    // attribute, so runs map to rows.
    attribute: text("attribute").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // From the first attempt the row holds a slot. Its runs are looked up from
    // the earliest attempt, which never moves forward; the settle period runs
    // from the latest.
    firstAttemptedAt: timestamp("first_attempted_at", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    // Runs the engine chose to cancel, recorded before the cancel: once
    // cancelled, never this row's run.
    cancelledRunIds: jsonb("cancelled_run_ids").$type<string[]>(),
    runId: text("run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    // Live runs of this occurrence beyond the one it should have.
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
  attribute: string;
  occurredAt: Date;
  firstAttemptedAt: Date | null;
  attemptedAt: Date | null;
  cancelledRunIds: string[] | null;
  runId: string | null;
  startedAt: Date | null;
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
    row: Pick<
      Occurrence,
      "trigger" | "occurrence" | "state" | "inputs" | "attribute" | "occurredAt"
    >,
  ): Promise<boolean>;
  /** Oldest occurrence first. */
  pending(trigger: string): Promise<Occurrence[]>;
  /** Mark a pending row as about to start at this time. */
  attempt(trigger: string, occurrence: string, at: Date): Promise<void>;
  /** Record that the engine is about to cancel this run. */
  cancelling(trigger: string, occurrence: string, runId: string): Promise<void>;
  started(trigger: string, occurrence: string, runId: string, at: Date): Promise<void>;
  failed(trigger: string, occurrence: string, report: CheckReport): Promise<void>;
  /** The rows whose occurrence attribute is one of these, whatever their state. */
  byAttribute(trigger: string, attributes: readonly string[]): Promise<Occurrence[]>;
  /** Started rows started at or after this time. */
  startedSince(trigger: string, since: Date): Promise<Occurrence[]>;
  /** Record the live runs beyond the one expected, or clear them with null. */
  duplicated(trigger: string, occurrence: string, runIds: string[] | null): Promise<void>;
  /** Point a started row at the run of its occurrence that is still live. */
  repoint(trigger: string, occurrence: string, runId: string): Promise<void>;
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
    set: Partial<Pick<Occurrence, "state" | "runId" | "report" | "startedAt">>,
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
      const stamp = sql`${at.toISOString()}::timestamptz`;
      const updated = await db
        .update(occurrences)
        .set({
          // least(): a clock that stepped back lowers the bound, never raises it.
          firstAttemptedAt: sql`least(coalesce(${occurrences.firstAttemptedAt}, ${stamp}), ${stamp})`,
          attemptedAt: at,
          updatedAt: sql`now()`,
        })
        .where(and(row(trigger, occurrence), eq(occurrences.state, "pending")))
        .returning({ occurrence: occurrences.occurrence });
      if (updated.length === 0) throw new Error(`${trigger} ${occurrence} is no longer pending`);
    },
    async cancelling(trigger, occurrence, runId) {
      await db
        .update(occurrences)
        .set({
          cancelledRunIds: sql`coalesce(${occurrences.cancelledRunIds}, '[]'::jsonb) || ${JSON.stringify([runId])}::jsonb`,
        })
        .where(row(trigger, occurrence));
    },
    started: (trigger, occurrence, runId, at) =>
      settle(trigger, occurrence, { state: "started", runId, startedAt: at }),
    failed: (trigger, occurrence, report) =>
      settle(trigger, occurrence, { state: "failed", report }),
    async byAttribute(trigger, attributes) {
      if (attributes.length === 0) return [];
      return db
        .select()
        .from(occurrences)
        .where(and(ofTrigger(trigger), inArray(occurrences.attribute, [...attributes])));
    },
    async startedSince(trigger, since) {
      return db
        .select()
        .from(occurrences)
        .where(
          and(
            ofTrigger(trigger),
            eq(occurrences.state, "started"),
            gte(occurrences.startedAt, since),
          ),
        );
    },
    async duplicated(trigger, occurrence, runIds) {
      await db.update(occurrences).set({ duplicateRunIds: runIds }).where(row(trigger, occurrence));
    },
    async repoint(trigger, occurrence, runId) {
      await db
        .update(occurrences)
        .set({ runId })
        .where(and(row(trigger, occurrence), eq(occurrences.state, "started")));
    },
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
            isNotNull(occurrences.firstAttemptedAt),
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
