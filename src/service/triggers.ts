/**
 * Start runs from the event triggers a factory declares, and inspect them.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import type { z } from "zod";
import { type Check, type CheckReport, failedCheck, failedChecks } from "../checks/index.ts";
import { plainHint } from "../errors.ts";
import { currentFactory, registrySql } from "../steps/runtime/registry.ts";
import type { EventTrigger, Factory } from "../workflow/factory.ts";
import { nudgeDelay } from "./nudge.ts";
import { whenReady } from "./readiness.ts";
import {
  cancelRun,
  eventTriggerId,
  findRunsByAttribute,
  liveRunsByAttribute,
  runStatuses,
} from "./runs.ts";
import { onShutdown } from "./shutdown.ts";
import {
  SOURCES,
  type Source,
  type SourceOccurrence,
  type SourceProvider,
  type SourceRegistry,
} from "./sources.ts";
import { type PreparedRun, prepareRun } from "./trigger.ts";
import {
  type Occurrence,
  type TriggerMarker,
  type TriggerStore,
  triggerStore,
} from "./trigger-store.ts";

type Ready = Extract<PreparedRun, { kind: "ready" }>;
type Refusal = Exclude<PreparedRun, { kind: "ready" }>;

const DEFAULT_MAX_ACTIVE = 3;
const DEFAULT_LOOKBACK_MINUTES = 60;
// How soon an occurrence waiting on the cap notices a run finishing. While
// nothing waits, each check is one read of the pending rows.
const DRAIN_INTERVAL_MS = 30_000;
const FAILURES_SHOWN = 5;

/** Injectable storage, sources, run operations and logging used by the trigger engine. */
export interface TriggerDeps {
  store?: TriggerStore;
  sources?: SourceRegistry;
  prepareRun?: typeof prepareRun;
  runStatuses?: typeof runStatuses;
  findRunsByAttribute?: typeof findRunsByAttribute;
  liveRunsByAttribute?: typeof liveRunsByAttribute;
  cancelRun?: typeof cancelRun;
  /** The factory slug the rows are recorded under. */
  factorySlug?: () => string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** One factory's valid event triggers, ready to poll, take pushes and start runs. */
export interface TriggerEngine {
  readonly triggers: ReadonlyArray<{ name: string; provider: SourceProvider }>;
  /** Write each trigger's first-enabled marker, then begin starting any leftover pending occurrence. */
  arm(): Promise<void>;
  poll(name: string): Promise<void>;
  /** Record the occurrence a pushed event is for, and return the triggers that took it. */
  push(provider: SourceProvider, event: unknown): Promise<string[]>;
  /** Start waiting occurrences, oldest first, up to each trigger's cap. */
  drain(): Promise<void>;
  /** Start nothing more, and settle once the drain in flight has. */
  stop(): Promise<void>;
}

interface Armed {
  name: string;
  trigger: EventTrigger;
  source: Source;
  params: unknown;
  maxActive: number;
  lookbackMinutes: number;
  workflowName: string | undefined;
  marker?: TriggerMarker;
}

// A plaintext run attribute, because a World that encrypts inputs hides the
// triggerId inside them. Hashed with the factory slug: fixed length whatever
// the occurrence key, and never equal to another factory's.
const OCCURRENCE_ATTRIBUTE = "jigs.occurrence";
// The SDK mints the run ID from this process's clock just after the attempt
// is recorded; the margin covers the clock stepping back in between.
const LOOKUP_MARGIN_MS = 60_000;
// How long an unconfirmed start is waited on: past the queue's first retries,
// and past the restart recovery that queues pending runs as the World boots.
const DELIVERY_SETTLE_MS = 5 * 60_000;
// How long a resilient start's not-yet-created run holds its slot; one created
// later can take the trigger one past maxActive.
const LATE_DELIVERY_MS = 60 * 60_000;
const START_WRITE_TRIES = 3;

// `jigs run` parses each `--input` value as JSON, so JSON round-trips every
// value on one line. A backtick is escaped too: it would end the command in a
// rendered repair.
const inputValue = (value: unknown): string => JSON.stringify(value).replaceAll("`", "\\u0060");

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** The value an occurrence's runs carry as their occurrence attribute. */
function occurrenceAttribute(factorySlug: string, trigger: string, occurrence: string): string {
  return createHash("sha256")
    .update(`${factorySlug}\n${eventTriggerId(trigger, occurrence)}`)
    .digest("hex");
}

type LiveRuns = Map<string, Array<{ runId: string; status: string }>>;

/** What a trigger's cap counts, shared by the engine and `jigs status` so the two agree. */
async function tally(
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

/**
 * The engine for a factory's valid triggers. An invalid trigger is logged
 * with its repair and left out: the service still starts, and `jigs doctor`
 * reports the same failure on demand.
 */
export function createTriggerEngine(factory: Factory, deps: TriggerDeps = {}): TriggerEngine {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const prepare = deps.prepareRun ?? prepareRun;
  const statusesOf = deps.runStatuses ?? runStatuses;
  const findRuns = deps.findRunsByAttribute ?? findRunsByAttribute;
  const cancel = deps.cancelRun ?? cancelRun;
  const liveRuns = deps.liveRunsByAttribute ?? liveRunsByAttribute;
  // When the World began delivering: set on arm, after the service's readiness
  // gates, whether or not the markers could be written. Until then no
  // uncertain row is settled.
  let bootedAt: Date | undefined;
  const slug = deps.factorySlug ?? currentFactory;
  let opened: TriggerStore | undefined = deps.store;
  const store = () => (opened ??= triggerStore(registrySql(), slug()));

  const armed: Armed[] = [];
  for (const [name, trigger] of Object.entries(factory.triggers ?? {})) {
    const resolved = resolveTrigger(factory, name, trigger, deps.sources ?? SOURCES);
    if ("reason" in resolved) {
      log(`[trigger] ${name} not started: ${resolved.reason}`);
      log(plainHint(resolved.repair));
      continue;
    }
    armed.push(resolved);
  }
  const byName = new Map(armed.map((entry) => [entry.name, entry]));

  let stopped = false;
  let marking: Promise<void> | undefined;
  let chain: Promise<void> = Promise.resolve();
  // A run whose `started` write failed, held until written. A crash loses it,
  // and the lookup finds the run again.
  const unrecorded = new Map<string, string>();
  // Rows whose start this process saw throw: a pending run of one may be a
  // run the queue never took.
  const threw = new Set<string>();
  const rowKey = (entry: Armed, occurrence: string) => `${entry.name}\0${occurrence}`;

  // Polls and pushes wait on this alone, never on a drain: a restart with a
  // backlog of pending rows must not hold a provider's push past its deadline.
  const markers = () =>
    (marking ??= (async () => {
      const at = now();
      for (const entry of armed) entry.marker = await store().enable(entry.name, at);
    })().catch((error: unknown) => {
      marking = undefined;
      throw error;
    }));

  // Occurrences before the trigger was first enabled are not its business at
  // all; ones older than the lookback are recorded so they are never started.
  async function observe(
    entry: Armed,
    seen: SourceOccurrence,
    occurrence: string,
  ): Promise<boolean> {
    const enabledAt = entry.marker?.enabledAt;
    if (enabledAt === undefined || seen.at < enabledAt) return false;
    const stale = seen.at.getTime() < now().getTime() - entry.lookbackMinutes * 60_000;
    const state = stale ? "skipped" : "pending";
    const recorded = await store().record({
      trigger: entry.name,
      occurrence,
      attribute: occurrenceAttribute(slug(), entry.name, occurrence),
      state,
      inputs: seen.inputs,
      occurredAt: seen.at,
    });
    if (recorded && stale) {
      log(
        `[trigger] ${entry.name} ${occurrence} skipped: older than its ${entry.lookbackMinutes}-minute lookback`,
      );
    }
    return recorded && !stale;
  }

  // A preflight check that threw or did not answer is no verdict: a blip in
  // reaching a provider must not end the occurrence. Nothing was started, so
  // the row is retried as it stands; a real refusal marks it failed.
  const unanswered = (refusal: Refusal) =>
    refusal.kind === "preflight-failed" &&
    failedChecks(refusal.report).every((check) => check.unanswered === true);

  async function refuse(entry: Armed, row: Occurrence, refusal: Refusal): Promise<void> {
    // Retried until the row is a settle period old; then its checks' silence
    // is the report.
    if (unanswered(refusal) && now().getTime() - row.createdAt.getTime() < DELIVERY_SETTLE_MS) {
      log(
        `[trigger] ${entry.name} ${row.occurrence} waits: preflight did not answer: ${failedChecks(
          (refusal as { report: CheckReport }).report,
        )
          .map((check) => `${check.label}: ${check.reason}`)
          .join("; ")}`,
      );
      return;
    }
    const report = failureReport(entry.name, refusal);
    await store().failed(entry.name, row.occurrence, report);
    log(
      `[trigger] ${entry.name} ${row.occurrence} failed: ${failedChecks(report)
        .map((check) => `${check.label}: ${check.reason}`)
        .join("; ")}`,
    );
  }

  const prepareFor = (entry: Armed, row: Occurrence) =>
    prepare(factory, entry.trigger.workflow, { ...entry.trigger.inputs, ...row.inputs });

  // The runs of this row's occurrence minted since its attempt, newest
  // first. Only its one start can have made them.
  const runsOf = async (entry: Armed, row: Occurrence) =>
    findRuns({
      ...(entry.workflowName === undefined ? {} : { workflowName: entry.workflowName }),
      key: OCCURRENCE_ATTRIBUTE,
      value: row.attribute,
      since: new Date((row.attemptedAt as Date).getTime() - LOOKUP_MARGIN_MS),
    });

  async function markStarted(entry: Armed, occurrence: string, runId: string): Promise<void> {
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

  // The row's one launch. The claim is a compare-and-set, so of two copies of
  // the service only one gets here; nothing ever launches the row again.
  async function launch(entry: Armed, row: Occurrence, prepared: Ready): Promise<boolean> {
    if (!(await store().attempt(entry.name, row.occurrence, now()))) {
      log(`[trigger] ${entry.name} ${row.occurrence}: claimed by another start`);
      return false;
    }
    let runId: string;
    try {
      runId = await prepared.launch(eventTriggerId(entry.name, row.occurrence), {
        [OCCURRENCE_ATTRIBUTE]: row.attribute,
      });
    } catch (error) {
      threw.add(rowKey(entry, row.occurrence));
      log(`[trigger] ${entry.name} ${row.occurrence} start failed: ${String(error)}`);
      return true;
    }
    await markStarted(entry, row.occurrence, runId);
    return true;
  }

  // An attempted row is never launched again: its run is adopted, or the row
  // fails for the operator.
  async function resolve(entry: Armed, row: Occurrence): Promise<void> {
    const key = rowKey(entry, row.occurrence);
    const held = unrecorded.get(key);
    if (held !== undefined) return markStarted(entry, row.occurrence, held);
    const found = await runsOf(entry, row);
    const moved = found.filter((run) => run.status !== "pending").at(-1);
    if (moved !== undefined) return markStarted(entry, row.occurrence, moved.runId);
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

  function unconfirmedReport(entry: Armed, row: Occurrence, cancelled?: string): CheckReport {
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

  // Counting from the runs that are live now. A live run of a row that failed
  // after its attempt is that attempt's run, late: only the row's one launch
  // can carry its attribute, so the row is marked started by it.
  async function reconcile(entry: Armed): Promise<number> {
    const live = await liveRuns(entry.workflowName, OCCURRENCE_ATTRIBUTE);
    const { active, rows } = await tally(store(), entry.name, live, statusesOf, now());
    for (const { row, runs } of rows) {
      const late = runs.at(-1);
      if (row.state === "failed" && row.attemptedAt !== null && late !== undefined) {
        await store().adoptLate(entry.name, row.occurrence, late.runId, now());
        log(`[trigger] ${entry.name} ${row.occurrence}: run ${late.runId} appeared after all`);
      }
    }
    return active;
  }

  // Each row on its own, so one that throws every drain cannot hold up the
  // rest of its trigger; an attempted row that throws still holds its slot.
  const isolated = async (entry: Armed, row: Occurrence, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      log(`[trigger] ${entry.name} ${row.occurrence} could not start: ${String(error)}`);
    }
  };

  async function startWaiting(entry: Armed, rows: Occurrence[]) {
    for (const row of rows) {
      if (stopped) return;
      if (row.attemptedAt !== null) await isolated(entry, row, () => resolve(entry, row));
    }
    let active = await reconcile(entry);
    const fresh = rows.filter((row) => row.attemptedAt === null);
    for (const [index, row] of fresh.entries()) {
      if (stopped) return;
      if (active >= entry.maxActive) {
        log(
          `[trigger] ${entry.name}: ${fresh.length - index} waiting, ${active} of ${entry.maxActive} runs active`,
        );
        return;
      }
      // Recorded only once preflight passed and the World is next: a failure
      // before it keeps its own report and is retried as a fresh row.
      let launched = false;
      await isolated(entry, row, async () => {
        const prepared = await prepareFor(entry, row);
        if (prepared.kind !== "ready") return refuse(entry, row, prepared);
        launched = await launch(entry, row, prepared);
      });
      if (launched) active += 1;
    }
  }

  // One drain at a time, so a push landing mid-drain cannot start the same
  // row twice. Nothing here throws: a rejected timer callback would take the
  // service down, and a row left pending is retried on the next drain. Each
  // trigger on its own, so one trigger's failing start holds up no other.
  async function drainOnce(): Promise<void> {
    for (const entry of armed) {
      if (stopped) return;
      try {
        await startWaiting(entry, await store().pending(entry.name));
      } catch (error) {
        log(`[trigger] ${entry.name} could not start waiting occurrences: ${String(error)}`);
      }
    }
  }
  const drain = (): Promise<void> => {
    chain = chain.then(drainOnce);
    return chain;
  };

  return {
    triggers: armed.map((entry) => ({ name: entry.name, provider: entry.source.provider })),
    async arm() {
      // Before the markers: arm runs once the World is ready, and a failed
      // marker write, retried by the polls, must not leave the clock unset.
      bootedAt ??= now();
      await markers();
      void drain();
    },
    drain,
    stop: () => {
      stopped = true;
      return chain;
    },
    async poll(name) {
      const entry = byName.get(name);
      if (entry === undefined) return;
      try {
        await markers();
        const marker = entry.marker as TriggerMarker;
        // Taken before the read, so an occurrence landing during it is in the
        // next window too; the overlap is deduplicated.
        const through = now();
        const polled = await entry.source.poll(entry.params, marker.polledThrough);
        let fresh = 0;
        let failedAt: Date | undefined;
        for (const seen of polled) {
          // An occurrence the source cannot key would fail the same way on every
          // poll, so it is passed over rather than held for.
          let occurrence: string;
          try {
            occurrence = entry.source.occurrence(seen.inputs);
          } catch (error) {
            log(`[trigger] ${name} passed over an occurrence it could not key: ${String(error)}`);
            continue;
          }
          try {
            if (await observe(entry, seen, occurrence)) fresh += 1;
          } catch (error) {
            if (failedAt === undefined || seen.at < failedAt) failedAt = seen.at;
            log(`[trigger] ${name} could not record an occurrence: ${String(error)}`);
          }
        }
        // An occurrence the store could not record keeps the window open
        // behind it, so the next poll sees it again, but never further back
        // than the lookback: anything older would only be skipped.
        const next =
          failedAt === undefined
            ? through
            : new Date(
                Math.max(
                  marker.polledThrough.getTime(),
                  Math.min(through.getTime(), failedAt.getTime() - 1),
                  now().getTime() - entry.lookbackMinutes * 60_000,
                ),
              );
        await store().advance(name, next);
        entry.marker = { ...marker, polledThrough: next };
        log(`[trigger] ${name}: polled, ${polled.length} seen, ${fresh} new`);
      } catch (error) {
        log(`[trigger] ${name} poll failed: ${String(error)}`);
        return;
      }
      await drain();
    },
    async push(provider, event) {
      await markers();
      const taken: string[] = [];
      for (const entry of armed) {
        if (entry.source.provider !== provider) continue;
        try {
          const pushed = await entry.source.fromPush(entry.params, event);
          if (pushed === null) continue;
          const occurrence = entry.source.occurrence(pushed.inputs);
          if (await observe(entry, pushed, occurrence)) taken.push(entry.name);
        } catch (error) {
          log(`[trigger] ${entry.name} could not read a pushed event: ${String(error)}`);
        }
      }
      // Not awaited: a provider wants its answer in seconds, and the row
      // already recorded is what makes the start certain.
      if (taken.length > 0) void drain();
      return taken;
    },
  };
}

/** Injectable timers, readiness and intervals, on top of the engine's own dependencies. */
export interface StartTriggersDeps extends TriggerDeps {
  intervalSeconds?: () => Promise<Record<SourceProvider, number>>;
  ready?: () => Promise<void>;
  random?: () => number;
  /** Schedules one call and returns its canceller. */
  setTimer?: (fire: () => void, ms: number) => () => void;
}

let running: TriggerEngine | undefined;

/**
 * Starts the factory's event triggers once the service is ready: leftover
 * pending occurrences first, then a poll per trigger on its provider's
 * interval, until the service shuts down.
 */
export function startTriggers(factory: Factory, deps: StartTriggersDeps = {}): TriggerEngine {
  const engine = createTriggerEngine(factory, deps);
  if (engine.triggers.length === 0) return engine;
  running = engine;
  const log = deps.log ?? console.log;
  const setTimer =
    deps.setTimer ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const cancels = new Map<string, () => void>();
  let stopped = false;
  // Quiesce, not close: a start still in flight needs the World and the
  // registry pool that the close phase ends.
  onShutdown(
    async () => {
      stopped = true;
      for (const cancel of cancels.values()) cancel();
      if (running === engine) running = undefined;
      await engine.stop();
    },
    { phase: "quiesce" },
  );

  const repeat = (key: string, delay: () => number, once: () => Promise<void>) => {
    const next = () => {
      if (!stopped)
        cancels.set(
          key,
          setTimer(() => void once().then(next), delay()),
        );
    };
    return next;
  };

  void (async () => {
    try {
      await (deps.ready ?? whenReady)();
      const intervals = await (deps.intervalSeconds ?? configuredIntervals)();
      if (stopped) return;
      // A failed arm's markers are retried by every poll, and its settle clock
      // is already set; the timers run either way.
      await engine.arm().catch((error: unknown) => {
        log(`[trigger] could not enable triggers, retrying on each poll: ${String(error)}`);
      });
      for (const { name, provider } of engine.triggers) {
        log(`[trigger] ${name} started: polls ${provider} every ${intervals[provider]}s`);
        const poll = () => engine.poll(name);
        // At once too: an occurrence from while the service was down is only
        // found by a poll.
        void poll().then(
          repeat(`poll:${name}`, () => nudgeDelay(intervals[provider], deps.random), poll),
        );
      }
      repeat("drain", () => DRAIN_INTERVAL_MS, engine.drain)();
    } catch (error) {
      log(`[trigger] event triggers not started: ${String(error)}`);
    }
  })();
  return engine;
}

/**
 * Hand a provider's pushed event to the running event triggers watching that
 * provider. It returns once the occurrence is recorded, before any run starts,
 * with the names of the triggers that took it.
 */
export async function pushEvent(provider: SourceProvider, event: unknown): Promise<string[]> {
  return running === undefined ? [] : running.push(provider, event);
}

async function configuredIntervals(): Promise<Record<SourceProvider, number>> {
  const [{ readFactoryConfig }, { factoryRoot }] = await Promise.all([
    import("../config/factory-config.ts"),
    import("../config/factory-root.ts"),
  ]);
  return readFactoryConfig(factoryRoot()).service.pollIntervalSeconds;
}

/** One failed occurrence, with the checks that refused its run. */
export interface TriggerFailure {
  occurrence: string;
  at: string;
  checks: Array<{ label: string; reason: string; repair: string }>;
}

/** Operator-facing state for one declared event trigger. */
export interface TriggerView {
  name: string;
  workflow: string;
  source: string;
  lastOccurrence: string | null;
  pending: number;
  active: number;
  failed: number;
  /** The most recent failures, newest first. */
  failures: TriggerFailure[];
}

/** Injectable storage, run reads and clock used by the trigger listing. */
export interface ListTriggersDeps {
  store?: TriggerStore;
  liveRunsByAttribute?: typeof liveRunsByAttribute;
  runStatuses?: typeof runStatuses;
  now?: () => Date;
}

/** What `jigs status` shows for each declared trigger, valid or not. */
export async function listTriggers(
  factory: Factory,
  deps: ListTriggersDeps = {},
): Promise<TriggerView[]> {
  const declared = Object.entries(factory.triggers ?? {});
  if (declared.length === 0) return [];
  const store = deps.store ?? triggerStore(registrySql(), currentFactory());
  const liveRuns = deps.liveRunsByAttribute ?? liveRunsByAttribute;
  const now = (deps.now ?? (() => new Date()))();
  return Promise.all(
    declared.map(async ([name, trigger]) => {
      const entry = factory.workflows[trigger.workflow];
      // A trigger naming no workflow of this factory has no runs to list; an
      // unfiltered listing would read every live run in the World.
      const live =
        entry === undefined
          ? new Map()
          : await liveRuns(
              (entry.workflow as { workflowId?: string }).workflowId,
              OCCURRENCE_ATTRIBUTE,
            );
      const [summary, { active }] = await Promise.all([
        store.summary(name, FAILURES_SHOWN),
        tally(store, name, live, deps.runStatuses ?? runStatuses, now),
      ]);
      return {
        name,
        workflow: trigger.workflow,
        source: trigger.source.kind,
        lastOccurrence: summary.lastOccurrence?.toISOString() ?? null,
        pending: summary.pending,
        active,
        failed: summary.failed,
        failures: summary.failures.map((row) => ({
          occurrence: row.occurrence,
          at: row.updatedAt.toISOString(),
          checks: row.report === null ? [] : failedChecks(row.report),
        })),
      };
    }),
  );
}

/**
 * Doctor's half: the same validations the engine refuses a trigger on, and for a valid trigger its
 * recent failed occurrences with their repairs.
 */
export function triggerChecks(
  factory: Factory,
  sources: SourceRegistry = SOURCES,
  deps: { store?: TriggerStore } = {},
): Check[] {
  return Object.entries(factory.triggers ?? {}).flatMap(([name, trigger]): Check[] => {
    const id = `trigger.${name}`;
    const label = `trigger ${name}`;
    const resolved = resolveTrigger(factory, name, trigger, sources);
    if ("reason" in resolved) return [failedCheck(id, label, resolved.reason, resolved.repair)];
    return [
      { id, label, run: async (): Promise<{ ok: true }> => ({ ok: true }) },
      {
        id: `${id}.failed`,
        label: `trigger ${name} occurrences`,
        // A note, not a failure: each failed occurrence waits on the operator,
        // and `jigs up`, which ends with doctor, must not refuse over one.
        run: async () => {
          const store = deps.store ?? triggerStore(registrySql(), currentFactory());
          const summary = await store.summary(name, FAILURES_SHOWN);
          if (summary.failed === 0) return { ok: true };
          return {
            ok: true,
            detail: [
              `${summary.failed} failed, each waiting on the operator`,
              ...summary.failures.flatMap((row) =>
                (row.report === null ? [] : failedChecks(row.report)).flatMap((check) => [
                  `${row.occurrence}: ${check.reason}`,
                  // Plain text: backticks mark commands only in rendered hints.
                  ...check.repair.split("\n").map((line) => `  ${line.replaceAll("`", "")}`),
                ]),
              ),
            ].join("\n"),
          };
        },
      },
    ];
  });
}

interface TriggerProblem {
  reason: string;
  repair: string;
}

function resolveTrigger(
  factory: Factory,
  name: string,
  trigger: EventTrigger,
  sources: SourceRegistry,
): Armed | TriggerProblem {
  const at = `triggers.${name}`;
  // The occurrence follows the name after a ":", and the trigger column reads
  // the name back by splitting on the first one.
  if (name.includes(":")) {
    return {
      reason: `trigger name "${name}" contains ":"`,
      repair: `rename the "${name}" trigger in jigs.config.ts to a name without ":"\na run's trigger id is read back out of the name`,
    };
  }
  const entry = factory.workflows[trigger.workflow];
  if (!entry) {
    return {
      reason: `workflow "${trigger.workflow}" is not one of this factory's workflows`,
      repair: `set ${at}.workflow in jigs.config.ts to one of: ${Object.keys(factory.workflows).join(", ")}`,
    };
  }
  const source = sources[trigger.source.kind];
  if (source === undefined) {
    return {
      reason: `source "${trigger.source.kind}" is not a source this jigs version provides`,
      repair: `set ${at}.source in jigs.config.ts to one of: ${Object.keys(sources).join(", ")}`,
    };
  }
  const params = source.params.safeParse(trigger.source.params);
  if (!params.success) {
    return {
      reason: `source params do not satisfy ${trigger.source.kind}: ${issues(params.error.issues)}`,
      repair: `fix ${at}.source in jigs.config.ts`,
    };
  }
  const maxActive = trigger.maxActive ?? DEFAULT_MAX_ACTIVE;
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    return {
      reason: `maxActive ${maxActive} is not a whole number of at least 1`,
      repair: `set ${at}.maxActive in jigs.config.ts to 1 or more, or remove it for the default of ${DEFAULT_MAX_ACTIVE}`,
    };
  }
  const lookbackMinutes = trigger.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES;
  if (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0) {
    return {
      reason: `lookbackMinutes ${lookbackMinutes} is not a positive number of minutes`,
      repair: `set ${at}.lookbackMinutes in jigs.config.ts above 0, or remove it for the default of ${DEFAULT_LOOKBACK_MINUTES}`,
    };
  }
  const clash = Object.keys(trigger.inputs ?? {}).filter((key) => key in source.sampleInputs);
  if (clash.length > 0) {
    return {
      reason: `inputs ${clash.join(", ")} ${clash.length === 1 ? "is" : "are"} also provided by the ${trigger.source.kind} source for each occurrence`,
      repair: `remove ${clash.join(", ")} from ${at}.inputs in jigs.config.ts\nthe source sets ${clash.length === 1 ? "it" : "them"} for each occurrence`,
    };
  }
  const inputs = entry.inputs.safeParse({ ...trigger.inputs, ...source.sampleInputs });
  if (!inputs.success) {
    return {
      reason: `the ${trigger.workflow} workflow does not accept what this trigger hands it: ${issues(inputs.error.issues)}`,
      repair: `make the ${trigger.workflow} workflow's inputs accept ${Object.keys(source.sampleInputs).join(", ") || "no fields"} from the ${trigger.source.kind} source, and fix ${at}.inputs in jigs.config.ts to supply the rest`,
    };
  }
  const workflowName = (entry.workflow as { workflowId?: string }).workflowId;
  return { name, trigger, source, params: params.data, maxActive, lookbackMinutes, workflowName };
}

function issues(list: z.core.$ZodIssue[]): string {
  return list.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ");
}

function failureReport(name: string, result: Refusal): CheckReport {
  if (result.kind === "preflight-failed") return result.report;
  const failure =
    result.kind === "unknown-workflow"
      ? {
          reason: `its workflow is not one of this factory's workflows (known: ${result.knownWorkflows.join(", ")})`,
          repair: `set triggers.${name}.workflow in jigs.config.ts to one of: ${result.knownWorkflows.join(", ")}`,
        }
      : {
          reason: `invalid inputs: ${issues(result.issues)}`,
          repair: `fix triggers.${name}.inputs in jigs.config.ts to satisfy its workflow's inputs`,
        };
  return {
    ok: false,
    checks: [{ id: `trigger.${name}`, label: `trigger ${name}`, ok: false, ...failure }],
  };
}
