// The engine that turns a factory's event triggers' occurrences into runs.

import { createHash } from "node:crypto";
import { type CheckReport, failedChecks } from "../../checks/index.ts";
import { currentFactoryContext } from "../../config/factory-context.ts";
import { plainHint } from "../../errors.ts";
import { registrySql } from "../../steps/runtime/registry.ts";
import type { Factory } from "../../workflow/factory.ts";
import type { Provider } from "../../workflow/providers.ts";
import { type PreparedRun, prepareRun } from "../launch.ts";
import {
  cancelRun,
  eventTriggerId,
  findRunsByAttribute,
  liveRunsByAttribute,
  OCCURRENCE_ATTRIBUTE,
  runStatuses,
} from "../runs.ts";
import { tally } from "./capacity.ts";
import { SOURCES, type SourceOccurrence, type SourceRegistry } from "./sources.ts";
import { DELIVERY_SETTLE_MS, startConfirmation } from "./start-confirmation.ts";
import { type Occurrence, type TriggerMarker, type TriggerStore, triggerStore } from "./store.ts";
import { issues, resolveTrigger, type ValidTrigger } from "./validate.ts";

type Ready = Extract<PreparedRun, { kind: "ready" }>;
type Refusal = Exclude<PreparedRun, { kind: "ready" }>;

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

/** One factory's valid event triggers, ready to take pushes and start runs. */
export interface TriggerEngine {
  readonly triggers: ReadonlyArray<{ name: string; provider: Provider }>;
  /** Write each trigger's first-enabled marker, then begin starting any leftover pending occurrence. */
  arm(): Promise<void>;
  /**
   * Record the occurrence a pushed event is for, and return the triggers that took it. Rejects
   * when a trigger could not read the event, after the others have taken it.
   */
  push(provider: Provider, event: unknown): Promise<string[]>;
  /** Start waiting occurrences, oldest first, up to each trigger's cap. */
  drain(): Promise<void>;
  /** Start nothing more, and settle once the drain in flight has. */
  stop(): Promise<void>;
}

interface Armed extends ValidTrigger {
  marker?: TriggerMarker;
}

const floorToSecond = (at: Date) => Math.floor(at.getTime() / 1000) * 1000;

/** The value an occurrence's runs carry as their occurrence attribute. */
function occurrenceAttribute(factorySlug: string, trigger: string, occurrence: string): string {
  return createHash("sha256")
    .update(`${factorySlug}\n${eventTriggerId(trigger, occurrence)}`)
    .digest("hex");
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
  const liveRuns = deps.liveRunsByAttribute ?? liveRunsByAttribute;
  // When the World began delivering: set on arm, after the service's readiness
  // gates, whether or not the markers could be written. Until then no
  // uncertain row is settled.
  let bootedAt: Date | undefined;
  const slug = deps.factorySlug ?? (() => currentFactoryContext().slug);
  let opened: TriggerStore | undefined = deps.store;
  const store = () => (opened ??= triggerStore(registrySql(), slug()));
  const confirmation = startConfirmation({
    store,
    findRuns: deps.findRunsByAttribute ?? findRunsByAttribute,
    cancel: deps.cancelRun ?? cancelRun,
    now,
    log,
    bootedAt: () => bootedAt,
  });

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

  let stopped = false;
  let marking: Promise<void> | undefined;
  let chain: Promise<void> = Promise.resolve();

  // Pushes wait on this alone, never on a drain: a restart with a backlog of
  // pending rows must not hold up the hub client's batch of events.
  const markers = () =>
    (marking ??= (async () => {
      const at = now();
      for (const entry of armed) entry.marker = await store().enable(entry.name, at);
    })().catch((error: unknown) => {
      marking = undefined;
      throw error;
    }));

  // Occurrences before the trigger was first enabled are not its business at
  // all, and the lookback cannot say so: a service down while a trigger was
  // added gets the hub's backlog on restart, and events in it from before the
  // trigger existed must not start runs however recent. Ones older than the
  // lookback are recorded so they are never started.
  // The comparison is by whole second, since some providers stamp only seconds
  // and an occurrence in the second of enabling must not read as before it.
  async function observe(entry: Armed, seen: SourceOccurrence): Promise<boolean> {
    const occurrence = seen.key;
    const enabledAt = entry.marker?.enabledAt;
    if (enabledAt === undefined || seen.at.getTime() < floorToSecond(enabledAt)) return false;
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
      confirmation.threw(entry, row.occurrence);
      log(`[trigger] ${entry.name} ${row.occurrence} start failed: ${String(error)}`);
      return true;
    }
    await confirmation.markStarted(entry, row.occurrence, runId);
    return true;
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
      if (row.attemptedAt !== null)
        await isolated(entry, row, () => confirmation.resolve(entry, row));
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
      // marker write, retried by the next push, must not leave the clock unset.
      bootedAt ??= now();
      await markers();
      void drain();
    },
    drain,
    stop: () => {
      stopped = true;
      return chain;
    },
    async push(provider, event) {
      await markers();
      const taken: string[] = [];
      const failures: unknown[] = [];
      for (const entry of armed) {
        if (entry.source.provider !== provider) continue;
        try {
          const pushed = await entry.source.fromPush(entry.params, event);
          if (pushed !== null && (await observe(entry, pushed))) taken.push(entry.name);
        } catch (error) {
          failures.push(error);
          log(`[trigger] ${entry.name} could not read a pushed event: ${String(error)}`);
        }
      }
      // Not awaited: the hub client routes its batch in order, so a start
      // must not hold up the next event, and the recorded row already makes
      // the start certain.
      if (taken.length > 0) void drain();
      // A trigger that could not tell whether the event was its occurrence
      // must not read as one that passed it over.
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `${failures.length} trigger(s) could not read the event`,
        );
      return taken;
    },
  };
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
