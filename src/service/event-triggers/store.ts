// The event triggers' record of every occurrence they saw, and where each
// trigger's polling has got to. The row, not the provider, is the dedupe
// record: a run that decides to do nothing leaves no trace anywhere else.

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import {
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { CheckReport } from "../../checks/index.ts";
import type { RegistrySql } from "../../steps/runtime/registry.ts";

// pg already parses jsonb; drizzle's own jsonb parses a string value a second
// time, which turns a cursor like "1790723244.335019" into a number.
const cursorColumn = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
});

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
    // Set once, by the one claim that may launch the row: from then it holds
    // a slot, and its run is looked up by attribute from this time.
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    runId: text("run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    report: jsonb("report").$type<CheckReport>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.factory, table.trigger, table.occurrence] }),
    index("jigs_triggers_attribute").on(table.factory, table.attribute),
  ],
);

export const markers = pgTable(
  "jigs_trigger_markers",
  {
    factory: text("factory").notNull(),
    trigger: text("trigger").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull(),
    // The source's own record of how far it has read, opaque here; null until
    // the trigger's first poll.
    cursor: cursorColumn("cursor"),
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
  attemptedAt: Date | null;
  runId: string | null;
  startedAt: Date | null;
  report: CheckReport | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TriggerMarker {
  enabledAt: Date;
  /** The cursor the trigger's source returned from its last poll, or null before the first. */
  cursor: unknown;
}

export interface TriggerSummary {
  lastOccurrence: Date | null;
  /** Pending rows not yet attempted. */
  pending: number;
  failed: number;
  /** The most recent failed rows, newest first. */
  failures: Occurrence[];
}

/** What the trigger engine reads and writes, over one factory's rows. */
export interface TriggerStore {
  /** The trigger's marker, written as `now` the first time it is asked for. */
  enable(trigger: string, now: Date): Promise<TriggerMarker>;
  advance(trigger: string, cursor: unknown): Promise<void>;
  /** Insert the row unless the occurrence is already recorded; true when it was new. */
  record(
    row: Pick<
      Occurrence,
      "trigger" | "occurrence" | "state" | "inputs" | "attribute" | "occurredAt"
    >,
  ): Promise<boolean>;
  /** Oldest occurrence first. */
  pending(trigger: string): Promise<Occurrence[]>;
  /** Claim a pending, never attempted row for its one start. False when it was already claimed. */
  attempt(trigger: string, occurrence: string, at: Date): Promise<boolean>;
  started(trigger: string, occurrence: string, runId: string, at: Date): Promise<void>;
  /** Mark a row that failed after its start was attempted as started, by the run that appeared. */
  adoptLate(trigger: string, occurrence: string, runId: string, at: Date): Promise<void>;
  failed(trigger: string, occurrence: string, report: CheckReport): Promise<void>;
  /** The rows whose occurrence attribute is one of these, whatever their state. */
  byAttribute(trigger: string, attributes: readonly string[]): Promise<Occurrence[]>;
  /** Started rows started at or after this time. */
  startedSince(trigger: string, since: Date): Promise<Occurrence[]>;
  summary(trigger: string, failures: number): Promise<TriggerSummary>;
}

/** The rows, of any trigger, whose occurrence attribute is one of these. */
export async function occurrencesByAttribute(
  db: RegistrySql,
  factory: string,
  attributes: readonly string[],
): Promise<Occurrence[]> {
  if (attributes.length === 0) return [];
  return db
    .select()
    .from(occurrences)
    .where(and(eq(occurrences.factory, factory), inArray(occurrences.attribute, [...attributes])));
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
      await db.insert(markers).values({ factory, trigger, enabledAt: now }).onConflictDoNothing();
      const [marker] = await db
        .select({ enabledAt: markers.enabledAt, cursor: markers.cursor })
        .from(markers)
        .where(and(eq(markers.factory, factory), eq(markers.trigger, trigger)));
      if (marker === undefined) throw new Error(`trigger ${trigger} has no marker after enabling`);
      return marker;
    },
    async advance(trigger, cursor) {
      await db
        .update(markers)
        .set({ cursor })
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
    // Compare and set: two copies of the service reading one row can never
    // both start it.
    async attempt(trigger, occurrence, at) {
      const claimed = await db
        .update(occurrences)
        .set({ attemptedAt: at, updatedAt: sql`now()` })
        .where(
          and(
            row(trigger, occurrence),
            eq(occurrences.state, "pending"),
            isNull(occurrences.attemptedAt),
          ),
        )
        .returning({ occurrence: occurrences.occurrence });
      return claimed.length > 0;
    },
    started: (trigger, occurrence, runId, at) =>
      settle(trigger, occurrence, { state: "started", runId, startedAt: at }),
    failed: (trigger, occurrence, report) =>
      settle(trigger, occurrence, { state: "failed", report }),
    async adoptLate(trigger, occurrence, runId, at) {
      await db
        .update(occurrences)
        .set({ state: "started", runId, startedAt: at, report: null, updatedAt: sql`now()` })
        .where(
          and(
            row(trigger, occurrence),
            eq(occurrences.state, "failed"),
            isNotNull(occurrences.attemptedAt),
          ),
        );
    },
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
      const rows = (state: OccurrenceState) => counts.find((c) => c.state === state)?.rows ?? 0;
      const lasts = counts.flatMap((c) => (c.last === null ? [] : [c.last.getTime()]));
      return {
        lastOccurrence: lasts.length === 0 ? null : new Date(Math.max(...lasts)),
        pending: rows("pending") - (attempted?.rows ?? 0),
        failed: rows("failed"),
        failures: recent,
      };
    },
  };
}
