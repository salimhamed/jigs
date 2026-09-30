// An in-memory trigger store for engine tests: the Postgres store's contract,
// checked against the real one by trigger-store.live.test.ts.

import type { Occurrence, TriggerMarker, TriggerStore } from "./trigger-store.ts";

export function memoryTriggerStore(now: () => Date, updatedAt: Date = now()) {
  const rows = new Map<string, Occurrence>();
  const marks = new Map<string, TriggerMarker>();
  const key = (trigger: string, occurrence: string) => `${trigger}\0${occurrence}`;
  const patch = (trigger: string, occurrence: string, change: Partial<Occurrence>) => {
    const row = rows.get(key(trigger, occurrence));
    if (row) rows.set(key(trigger, occurrence), { ...row, ...change });
  };
  const settle = (trigger: string, occurrence: string, change: Partial<Occurrence>) => {
    if (rows.get(key(trigger, occurrence))?.state === "pending") patch(trigger, occurrence, change);
  };
  const failures = { attempt: 0, started: 0 };
  const store: TriggerStore = {
    enable: async (trigger, now) => {
      if (!marks.has(trigger)) marks.set(trigger, { enabledAt: now, polledThrough: now });
      return marks.get(trigger) as TriggerMarker;
    },
    advance: async (trigger, polledThrough) => {
      const mark = marks.get(trigger);
      if (mark) marks.set(trigger, { ...mark, polledThrough });
    },
    record: async (row) => {
      if (rows.has(key(row.trigger, row.occurrence))) return false;
      rows.set(key(row.trigger, row.occurrence), {
        ...row,
        attemptedAt: null,
        runId: null,
        startedAt: null,
        report: null,
        createdAt: now(),
        updatedAt,
      });
      return true;
    },
    pending: async (trigger) =>
      [...rows.values()]
        .filter((row) => row.trigger === trigger && row.state === "pending")
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
    attempt: async (trigger, occurrence, at) => {
      if (failures.attempt > 0) {
        failures.attempt -= 1;
        throw new Error("attempt write failed");
      }
      const row = rows.get(key(trigger, occurrence));
      if (row?.state !== "pending" || row.attemptedAt !== null) return false;
      patch(trigger, occurrence, { attemptedAt: at });
      return true;
    },
    started: async (trigger, occurrence, runId, at) => {
      if (failures.started > 0) {
        failures.started -= 1;
        throw new Error("started write failed");
      }
      settle(trigger, occurrence, { state: "started", runId, startedAt: at });
    },
    failed: async (trigger, occurrence, report) =>
      settle(trigger, occurrence, { state: "failed", report }),
    adoptLate: async (trigger, occurrence, runId, at) => {
      const row = rows.get(key(trigger, occurrence));
      if (row?.state === "failed" && row.attemptedAt !== null)
        patch(trigger, occurrence, { state: "started", runId, startedAt: at, report: null });
    },
    byAttribute: async (trigger, attributes) =>
      [...rows.values()].filter(
        (row) => row.trigger === trigger && attributes.includes(row.attribute),
      ),
    startedSince: async (trigger, since) =>
      [...rows.values()].filter(
        (row) =>
          row.trigger === trigger &&
          row.state === "started" &&
          row.startedAt !== null &&
          row.startedAt >= since,
      ),
    summary: async (trigger) => {
      const mine = [...rows.values()].filter((row) => row.trigger === trigger);
      return {
        lastOccurrence: null,
        pending: mine.filter((row) => row.state === "pending" && row.attemptedAt === null).length,
        failed: mine.filter((row) => row.state === "failed").length,
        failures: mine.filter((row) => row.state === "failed"),
      };
    },
  };
  const state = (trigger: string, occurrence: string) => rows.get(key(trigger, occurrence));
  return { store, rows, marks, state, failures };
}
