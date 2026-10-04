// Settling a start whose outcome this process does not know: the run it made
// is adopted, or the occurrence fails for the operator. Nothing here launches.

import type { CheckReport } from "../../checks/index.ts";
import { type cancelRun, type findRunsByAttribute, OCCURRENCE_ATTRIBUTE } from "../runs.ts";
import type { Occurrence, TriggerStore } from "./store.ts";
import type { ValidTrigger } from "./validate.ts";

// The SDK mints the run ID from this process's clock just after the attempt
// is recorded; the margin covers the clock stepping back in between.
const LOOKUP_MARGIN_MS = 60_000;
// How long an unconfirmed start is waited on: past the queue's first retries,
// and past the restart recovery that queues pending runs as the World boots.
export const DELIVERY_SETTLE_MS = 5 * 60_000;
const START_WRITE_TRIES = 3;

// `jigs run` parses each `--input` value as JSON, so JSON round-trips every
// value on one line. A backtick is escaped too: it would end the command in a
// rendered repair.
const inputValue = (value: unknown): string => JSON.stringify(value).replaceAll("`", "\\u0060");

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

export interface StartConfirmationDeps {
  store: () => TriggerStore;
  findRuns: typeof findRunsByAttribute;
  cancel: typeof cancelRun;
  now: () => Date;
  log: (line: string) => void;
  /** When the World began delivering; until then no uncertain row is settled. */
  bootedAt: () => Date | undefined;
}

export interface StartConfirmation {
  /** Record the row's run as started, holding its ID in memory while the write fails. */
  markStarted(entry: ValidTrigger, occurrence: string, runId: string): Promise<void>;
  /** Note that this process saw the row's start throw. */
  threw(entry: ValidTrigger, occurrence: string): void;
  /** Adopt an attempted row's run, or fail the row once its start can no longer appear. */
  resolve(entry: ValidTrigger, row: Occurrence): Promise<void>;
}

export function startConfirmation(deps: StartConfirmationDeps): StartConfirmation {
  const { store, findRuns, cancel, now, log } = deps;
  // A run whose `started` write failed, held until written. A crash loses it,
  // and the lookup finds the run again.
  const unrecorded = new Map<string, string>();
  // Rows whose start this process saw throw: a pending run of one may be a
  // run the queue never took.
  const threw = new Set<string>();
  const rowKey = (entry: ValidTrigger, occurrence: string) => `${entry.name}\0${occurrence}`;

  // The runs of this row's occurrence minted since its attempt, newest
  // first. Only its one start can have made them.
  const runsOf = async (entry: ValidTrigger, row: Occurrence) =>
    findRuns({
      ...(entry.workflowName === undefined ? {} : { workflowName: entry.workflowName }),
      key: OCCURRENCE_ATTRIBUTE,
      value: row.attribute,
      since: new Date((row.attemptedAt as Date).getTime() - LOOKUP_MARGIN_MS),
    });

  async function markStarted(entry: ValidTrigger, occurrence: string, runId: string) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await store().started(entry.name, occurrence, runId, now());
        unrecorded.delete(rowKey(entry, occurrence));
        log(`[trigger] ${entry.name} ${occurrence}: run ${runId} of ${entry.trigger.workflow}`);
        return;
      } catch (error) {
        if (attempt < START_WRITE_TRIES) continue;
        unrecorded.set(rowKey(entry, occurrence), runId);
        log(
          `[trigger] ${entry.name} ${occurrence}: run ${runId} not recorded yet: ${String(error)}`,
        );
        return;
      }
    }
  }

  // An attempted row is never launched again: its run is adopted, or the row
  // fails for the operator.
  async function resolve(entry: ValidTrigger, row: Occurrence): Promise<void> {
    const key = rowKey(entry, row.occurrence);
    const held = unrecorded.get(key);
    if (held !== undefined) return markStarted(entry, row.occurrence, held);
    const found = await runsOf(entry, row);
    const moved = found.filter((run) => run.status !== "pending").at(-1);
    if (moved !== undefined) return markStarted(entry, row.occurrence, moved.runId);
    const bootedAt = deps.bootedAt();
    if (bootedAt === undefined) return;
    const since = Math.max((row.attemptedAt as Date).getTime(), bootedAt.getTime());
    if (now().getTime() - since < DELIVERY_SETTLE_MS) return;
    const pending = found.at(-1);
    // After a crash the World's restart recovery queues a pending run, so it
    // is adopted. One this process saw start() throw on was created but never
    // queued: nothing will run it, so it is cancelled. (A cancel that races
    // its delivery can still stop a run that just began; the row fails either
    // way.)
    if (pending !== undefined && !threw.has(key))
      return markStarted(entry, row.occurrence, pending.runId);
    // A run that could not be cancelled keeps the row attempted, so the next
    // drain tries again rather than failing a row whose run may yet run.
    for (const run of found) {
      try {
        await cancel(run.runId);
      } catch (error) {
        log(
          `[trigger] ${entry.name} ${row.occurrence}: could not cancel run ${run.runId}: ${String(error)}`,
        );
        return;
      }
    }
    await store().failed(entry.name, row.occurrence, unconfirmedReport(entry, row, pending?.runId));
    threw.delete(key);
    log(`[trigger] ${entry.name} ${row.occurrence} failed: its start could not be confirmed`);
  }

  return {
    markStarted,
    threw: (entry, occurrence) => {
      threw.add(rowKey(entry, occurrence));
    },
    resolve,
  };
}

function unconfirmedReport(entry: ValidTrigger, row: Occurrence, cancelled?: string): CheckReport {
  const workflow = entry.trigger.workflow;
  const inputs = Object.entries({ ...entry.trigger.inputs, ...row.inputs })
    .map(([key, value]) => ` --input ${shellQuote(`${key}=${inputValue(value)}`)}`)
    .join("");
  const run = `\`pnpm exec jigs run ${workflow}${inputs}\``;
  return {
    ok: false,
    checks: [
      {
        id: `trigger.${entry.name}`,
        label: `trigger ${entry.name}`,
        ok: false,
        reason:
          cancelled === undefined
            ? `its start could not be confirmed: no run of ${workflow} appeared`
            : `its run ${cancelled} was created but never queued, and was cancelled`,
        // Check first either way: a cancel can race a run that had just begun.
        repair: `check \`pnpm exec jigs status\` for a run of ${workflow} started around ${(row.attemptedAt as Date).toISOString()}\nif there is none, start it:\n${run}\njigs adopts the run if one appears later`,
      },
    ],
  };
}
