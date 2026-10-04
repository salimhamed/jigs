// What counts against a trigger's maxActive.

import type { runStatuses } from "../runs.ts";
import type { Occurrence, TriggerStore } from "./store.ts";

// How long a resilient start's not-yet-created run holds its slot; one created
// later can take the trigger one past maxActive.
const LATE_DELIVERY_MS = 60 * 60_000;

export type LiveRuns = Map<string, Array<{ runId: string; status: string }>>;

/** What a trigger's cap counts, shared by the engine and `jigs status` so the two agree. */
export async function tally(
  store: TriggerStore,
  trigger: string,
  live: LiveRuns,
  statuses: typeof runStatuses,
  now: Date,
): Promise<{ active: number; rows: Array<{ row: Occurrence; runs: Array<{ runId: string }> }> }> {
  const recentSince = new Date(now.getTime() - LATE_DELIVERY_MS);
  const [withRuns, pending, recent] = await Promise.all([
    store.byAttribute(trigger, [...live.keys()]),
    store.pending(trigger),
    store.startedSince(trigger, recentSince),
  ]);
  const rows = new Map<string, Occurrence>();
  for (const row of [...withRuns, ...pending.filter((p) => p.attemptedAt !== null), ...recent])
    rows.set(row.occurrence, row);
  const liveIds = new Set([...live.values()].flat().map((run) => run.runId));
  const unseen = recent.flatMap((row) => (row.runId && !liveIds.has(row.runId) ? [row.runId] : []));
  // A resilient run created between the listing above and this read is held
  // but not in the listing, so it counts nowhere this once: one over the cap.
  const held = await statuses(unseen);
  let active = 0;
  const counted = [...rows.values()].map((row) => {
    const runs = live.get(row.attribute) ?? [];
    let count = runs.length;
    if (row.state === "pending") count = Math.max(1, count);
    else if (
      row.state === "started" &&
      count === 0 &&
      row.runId !== null &&
      !held.has(row.runId) &&
      row.startedAt !== null &&
      row.startedAt >= recentSince
    )
      count = 1;
    active += count;
    return { row, runs };
  });
  return { active, rows: counted };
}
