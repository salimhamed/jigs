/**
 * Start runs from the event triggers a factory declares, and inspect them.
 *
 * @packageDocumentation
 */

import { randomInt } from "node:crypto";
import type { z } from "zod";
import { type Check, type CheckReport, failedCheck, failedChecks } from "../checks/index.ts";
import { plainHint } from "../errors.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import { currentFactory, registrySql } from "../steps/runtime/registry.ts";
import { finished } from "../steps/runtime/run-state.ts";
import type { EventTrigger, Factory } from "../workflow/factory.ts";
import { nudgeDelay } from "./nudge.ts";
import { whenReady } from "./readiness.ts";
import { eventTriggerId, listRuns, runStatuses } from "./runs.ts";
import { onShutdown } from "./shutdown.ts";
import {
  SOURCES,
  type Source,
  type SourceEvent,
  type SourceProvider,
  type SourceRegistry,
} from "./sources.ts";
import { type StartRunResult, startRun } from "./trigger.ts";
import {
  type Occurrence,
  type TriggerMarker,
  type TriggerStore,
  triggerStore,
} from "./trigger-store.ts";

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
  startRun?: typeof startRun;
  runStatuses?: typeof runStatuses;
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
  marker?: TriggerMarker;
}

// A resilient start can hand back a run ID before the World writes the run,
// and a start whose outcome was lost may still be in the queue, so a run the
// World does not hold yet counts as active for this long. For an attempt that
// is uncertain, the wait runs from this process's start too: a queued start
// is delivered only once the World runs again.
const UNWRITTEN_RUN_GRACE_MS = 10 * 60_000;
// The World refuses to create a run whose ID was minted more than a day ago,
// so an attempt older than this can neither be retried under its ID nor be
// told apart from one that never reached the World.
const RUN_ID_LIFETIME_MS = 23 * 3_600_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A run ID in the SDK's own shape, `wrun_` and a ULID of this time. */
function mintRunId(at: Date): string {
  let time = "";
  for (let ms = at.getTime(), i = 0; i < 10; i += 1, ms = Math.floor(ms / 32))
    time = CROCKFORD[ms % 32] + time;
  let random = "";
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[randomInt(32)];
  return `wrun_${time}${random}`;
}

/**
 * The engine for a factory's valid triggers. An invalid trigger is logged
 * with its repair and left out: the service still starts, and `jigs doctor`
 * reports the same failure on demand.
 */
export function createTriggerEngine(factory: Factory, deps: TriggerDeps = {}): TriggerEngine {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  const start = deps.startRun ?? startRun;
  const statusesOf = deps.runStatuses ?? runStatuses;
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
  let armedAt: Date | undefined;
  let chain: Promise<void> = Promise.resolve();

  // Polls and pushes wait on this alone, never on a drain: a restart with a
  // backlog of pending rows must not hold a provider's push past its deadline.
  const markers = () =>
    (marking ??= (async () => {
      const at = now();
      for (const entry of armed) entry.marker = await store().enable(entry.name, at);
      armedAt = at;
    })().catch((error: unknown) => {
      marking = undefined;
      throw error;
    }));

  // Occurrences before the trigger was first enabled are not its business at
  // all; ones older than the lookback are recorded so they are never started.
  async function observe(entry: Armed, event: SourceEvent, occurrence: string): Promise<boolean> {
    const enabledAt = entry.marker?.enabledAt;
    if (enabledAt === undefined || event.at < enabledAt) return false;
    const stale = event.at.getTime() < now().getTime() - entry.lookbackMinutes * 60_000;
    const state = stale ? "skipped" : "pending";
    const recorded = await store().record({
      trigger: entry.name,
      occurrence,
      state,
      inputs: event.inputs,
      occurredAt: event.at,
    });
    if (recorded && stale) {
      log(
        `[trigger] ${entry.name} ${occurrence} skipped: older than its ${entry.lookbackMinutes}-minute lookback`,
      );
    }
    return recorded && !stale;
  }

  // The trigger's own started rows, not a scan of the World: a run another
  // factory started, or one whose inputs the World encrypts, cannot miscount.
  async function activeRuns(entry: Armed): Promise<number> {
    const started = await store().unsettled(entry.name);
    const statuses = await statusesOf(started.flatMap((row) => (row.runId ? [row.runId] : [])));
    let active = 0;
    for (const row of started) {
      const status = row.runId === null ? undefined : statuses.get(row.runId);
      const settled =
        status === undefined
          ? now().getTime() - row.startedAt.getTime() > UNWRITTEN_RUN_GRACE_MS
          : TERMINAL_RUN_STATUSES.has(status);
      if (settled) await store().settle(entry.name, row.occurrence);
      else active += 1;
    }
    return active;
  }

  // Every attempted row first, whatever its age: its run may be live, so it
  // counts before any fresh occurrence is admitted, or a late older one could
  // take the slot a recovered run already holds.
  async function startWaiting(entry: Armed, rows: Occurrence[]) {
    let active = await activeRuns(entry);
    const attempted = rows.filter((row) => row.attemptedAt !== null && row.runId !== null);
    const statuses = await statusesOf(attempted.map((row) => row.runId as string));
    const retry = new Set<Occurrence>();
    for (const row of attempted) {
      const runId = row.runId as string;
      const attemptedAt = row.attemptedAt as Date;
      if (statuses.has(runId)) {
        await store().started(entry.name, row.occurrence, runId);
        active += 1;
        log(`[trigger] ${entry.name} ${row.occurrence}: run ${runId} was already started`);
        continue;
      }
      if (now().getTime() - attemptedAt.getTime() > RUN_ID_LIFETIME_MS) {
        await store().failed(
          entry.name,
          row.occurrence,
          uncertainReport(entry.name, entry.trigger.workflow, runId),
        );
        log(`[trigger] ${entry.name} ${row.occurrence} failed: run ${runId} never appeared`);
        continue;
      }
      const since = Math.max(attemptedAt.getTime(), (armedAt ?? now()).getTime());
      if (now().getTime() - since > UNWRITTEN_RUN_GRACE_MS) retry.add(row);
      else active += 1;
    }
    const admissible = rows.filter((row) => row.attemptedAt === null || retry.has(row));
    for (const [index, row] of admissible.entries()) {
      if (stopped) return;
      if (active >= entry.maxActive) {
        log(
          `[trigger] ${entry.name}: ${admissible.length - index} waiting, ${active} of ${entry.maxActive} runs active`,
        );
        return;
      }
      // The ID is written before the start and reused by every retry, so a
      // start whose outcome was lost can only ever be that one run.
      const { runId } = await store().attempt(entry.name, row.occurrence, mintRunId(now()), now());
      const result = await start(
        factory,
        entry.trigger.workflow,
        { ...entry.trigger.inputs, ...row.inputs },
        eventTriggerId(entry.name, row.occurrence),
        runId,
      );
      if (result.kind === "started") {
        await store().started(entry.name, row.occurrence, result.runId);
        active += 1;
        log(
          `[trigger] ${entry.name} ${row.occurrence}: run ${result.runId} of ${entry.trigger.workflow}`,
        );
        continue;
      }
      const report = failureReport(entry.name, result);
      await store().failed(entry.name, row.occurrence, report);
      log(
        `[trigger] ${entry.name} ${row.occurrence} failed: ${failedChecks(report)
          .map((check) => `${check.label}: ${check.reason}`)
          .join("; ")}`,
      );
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
        const rows = await store().pending(entry.name);
        if (rows.length > 0) await startWaiting(entry, rows);
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
        const events = await entry.source.poll(entry.params, marker.polledThrough);
        let fresh = 0;
        let unrecorded: Date | undefined;
        for (const event of events) {
          // An event the source cannot key would fail the same way on every
          // poll, so it is passed over rather than held for.
          let occurrence: string;
          try {
            occurrence = entry.source.occurrence(event.inputs);
          } catch (error) {
            log(`[trigger] ${name} passed over an event: ${String(error)}`);
            continue;
          }
          try {
            if (await observe(entry, event, occurrence)) fresh += 1;
          } catch (error) {
            if (unrecorded === undefined || event.at < unrecorded) unrecorded = event.at;
            log(`[trigger] ${name} could not record an occurrence: ${String(error)}`);
          }
        }
        // An occurrence the store could not record keeps the window open
        // behind it, so the next poll sees it again, but never further back
        // than the lookback: anything older would only be skipped.
        const next =
          unrecorded === undefined
            ? through
            : new Date(
                Math.max(
                  marker.polledThrough.getTime(),
                  Math.min(through.getTime(), unrecorded.getTime() - 1),
                  now().getTime() - entry.lookbackMinutes * 60_000,
                ),
              );
        await store().advance(name, next);
        entry.marker = { ...marker, polledThrough: next };
        log(`[trigger] ${name}: polled, ${events.length} seen, ${fresh} new`);
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
          const pushed = entry.source.fromPush(entry.params, event);
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
      // A failed arm is retried by every poll; the timers run either way.
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
  lastEvent: string | null;
  pending: number;
  active: number;
  failed: number;
  /** The most recent failures, newest first. */
  failures: TriggerFailure[];
}

/** Injectable storage and run listing used by the trigger listing. */
export interface ListTriggersDeps {
  store?: TriggerStore;
  listRuns?: typeof listRuns;
}

/** What `jigs status` shows for each declared trigger, valid or not. */
export async function listTriggers(
  factory: Factory,
  deps: ListTriggersDeps = {},
): Promise<TriggerView[]> {
  const declared = Object.entries(factory.triggers ?? {});
  if (declared.length === 0) return [];
  const store = deps.store ?? triggerStore(registrySql(), currentFactory());
  const rows = await (deps.listRuns ?? listRuns)(factory);
  const live = new Set(rows.filter((row) => !finished(row)).map((row) => row.runId));
  return Promise.all(
    declared.map(async ([name, trigger]) => {
      const [summary, started] = await Promise.all([
        store.summary(name, FAILURES_SHOWN),
        store.unsettled(name),
      ]);
      return {
        name,
        workflow: trigger.workflow,
        source: trigger.source.kind,
        lastEvent: summary.lastEvent?.toISOString() ?? null,
        pending: summary.pending,
        active: started.filter((row) => row.runId !== null && live.has(row.runId)).length,
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

/** Doctor's half: the same validations the engine refuses a trigger on, one check per trigger. */
export function triggerChecks(factory: Factory, sources: SourceRegistry = SOURCES): Check[] {
  return Object.entries(factory.triggers ?? {}).map(([name, trigger]) => {
    const id = `trigger.${name}`;
    const label = `trigger ${name}`;
    const resolved = resolveTrigger(factory, name, trigger, sources);
    return "reason" in resolved
      ? failedCheck(id, label, resolved.reason, resolved.repair)
      : { id, label, run: async (): Promise<{ ok: true }> => ({ ok: true }) };
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
    const known = Object.keys(sources);
    return {
      reason: `source "${trigger.source.kind}" is not a source this jigs version provides`,
      repair:
        known.length === 0
          ? `remove the "${name}" trigger from jigs.config.ts\nthis jigs version provides no sources; upgrade jigs for the one it names`
          : `set ${at}.source in jigs.config.ts to one of: ${known.join(", ")}`,
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
  const inputs = entry.inputs.safeParse({ ...trigger.inputs, ...source.sampleInputs });
  if (!inputs.success) {
    return {
      reason: `the ${trigger.workflow} workflow does not accept what this trigger hands it: ${issues(inputs.error.issues)}`,
      repair: `make the ${trigger.workflow} workflow's inputs accept ${Object.keys(source.sampleInputs).join(", ") || "no fields"} from the ${trigger.source.kind} source, and fix ${at}.inputs in jigs.config.ts to supply the rest`,
    };
  }
  return { name, trigger, source, params: params.data, maxActive, lookbackMinutes };
}

function issues(list: z.core.$ZodIssue[]): string {
  return list.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ");
}

function uncertainReport(name: string, workflow: string, runId: string): CheckReport {
  return {
    ok: false,
    checks: [
      {
        id: `trigger.${name}`,
        label: `trigger ${name}`,
        ok: false,
        reason: `its start was attempted more than 23 hours ago as run ${runId}, and that run never appeared`,
        repair: `check \`pnpm exec jigs status ${runId}\`\nif no such run exists, the occurrence was never started; start it with \`pnpm exec jigs run ${workflow}\` and its inputs`,
      },
    ],
  };
}

function failureReport(
  name: string,
  result: Exclude<StartRunResult, { kind: "started" }>,
): CheckReport {
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
