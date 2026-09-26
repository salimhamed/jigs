/**
 * Release the resources of finished factory runs automatically, by release policy.
 *
 * @packageDocumentation
 */

import { getWorld } from "workflow/runtime";
import { readFactoryConfig } from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import {
  currentFactory,
  listResources,
  type RegistrySql,
  registrySql,
  withRunResourceLock,
} from "../steps/runtime/registry.ts";
import { releaseRun } from "../steps/runtime/release.ts";
import { effectiveReleasePolicy, workflowReleasePolicy } from "../steps/runtime/release-policy.ts";
import { releasable } from "../steps/runtime/resource-kinds.ts";
import { worldRunFacts } from "../steps/runtime/resources.ts";
import { readRunState } from "../steps/runtime/run-state.ts";
import type { Factory } from "../workflow/factory.ts";
import type { ReleasePolicy } from "../workflow/runtime/release.ts";
import type { ResourceRecord, RunState } from "../workflow/runtime/resources.ts";
import { isReady } from "./readiness.ts";
import { onShutdown } from "./shutdown.ts";
import { runsWithActiveStep } from "./stalls.ts";

/** Recovery interval for discovering terminal runs that still need cleanup. */
export const AUTOMATIC_RELEASE_INTERVAL_MS = 60_000;

/** What release policy chose for a finished run. */
export type CleanupAction = "release" | "keep";
/** Whether a finished run completed, or failed or was cancelled. */
export type CleanupOutcome = "success" | "failure";

/** Injectable operations used by automatic release reconciliation. */
export interface AutomaticReleaseDeps {
  /** Runs that still hold live or failed resources jigs can release. */
  pendingRuns: () => Promise<RunState[]>;
  readState: (runId: string) => Promise<RunState>;
  waitForTerminal: (runId: string, signal: AbortSignal) => Promise<unknown>;
  hasActiveStep: (runId: string) => Promise<boolean>;
  policy: (factory: Factory, run: RunState, outcome: CleanupOutcome) => CleanupAction;
  withLock: <T>(runId: string, action: (sql: RegistrySql) => Promise<T>) => Promise<T>;
  release: (
    sql: RegistrySql,
    run: RunState,
    action: CleanupAction,
    keepReason: string,
  ) => Promise<ResourceRecord[]>;
  ready: () => boolean;
  log: (line: string) => void;
  warn: (line: string) => void;
  setTimer: (fire: () => void, ms: number) => () => void;
}

/** Counts from one automatic release reconciliation pass. */
export interface AutomaticReleaseReport {
  considered: number;
  released: number;
  kept: number;
  busy: number;
  failed: number;
}

// A run the World no longer knows is as finished as one that completed:
// nothing will ever come back for its resources.
const finished = (run: RunState): boolean =>
  run.status === null || TERMINAL_RUN_STATUSES.has(run.status);

/** Resolve the cleanup action for a workflow outcome and its effective release policy. */
export function automaticReleaseAction(
  factory: Factory,
  workflowName: string,
  outcome: CleanupOutcome,
  factoryPolicy?: ReleasePolicy,
): CleanupAction {
  const policy = effectiveReleasePolicy(
    workflowReleasePolicy(factory, workflowName),
    factoryPolicy,
  );
  return outcome === "success" ? policy.onSuccess : policy.onFailure;
}

/** One idempotent recovery pass; the long-poll watcher only makes this run sooner. */
export async function reconcileAutomaticRelease(
  factory: Factory,
  deps: AutomaticReleaseDeps = automaticReleaseDeps(),
  options: { canStart?: () => boolean } = {},
): Promise<AutomaticReleaseReport> {
  const report: AutomaticReleaseReport = {
    considered: 0,
    released: 0,
    kept: 0,
    busy: 0,
    failed: 0,
  };
  for (const run of (await deps.pendingRuns()).filter(finished)) {
    if (options.canStart?.() === false) break;
    report.considered += 1;
    report[await cleanupTerminalRun(factory, run, deps)] += 1;
  }
  return report;
}

async function cleanupTerminalRun(
  factory: Factory,
  run: RunState,
  deps: AutomaticReleaseDeps,
): Promise<"released" | "kept" | "busy" | "failed"> {
  const outcome: CleanupOutcome = run.status === "completed" ? "success" : "failure";
  const action = deps.policy(factory, run, outcome);
  const keepReason = `${outcome === "success" ? "onSuccess" : "onFailure"} policy keeps run resources`;
  if (await deps.hasActiveStep(run.runId)) return "busy";
  try {
    return await deps.withLock(run.runId, async (sql) => {
      // Cancellation can settle the run before its active step completes.
      // Recheck after acquiring the same lock provisioning holds.
      if (await deps.hasActiveStep(run.runId)) return "busy";
      const records = await deps.release(sql, run, action, keepReason);
      if (records.some((record) => record.state === "failed")) return "failed";
      return action === "keep" ? "kept" : "released";
    });
  } catch (error) {
    deps.warn(
      `[cleanup] run ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}

/** Start notification-fast cleanup with polling recovery and restart reconciliation. */
export function startAutomaticRelease(
  factory: Factory,
  deps: AutomaticReleaseDeps = automaticReleaseDeps(),
): { stop: () => Promise<void> } {
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;
  const watches = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();

  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  };

  const schedule = (ms = AUTOMATIC_RELEASE_INTERVAL_MS) => {
    if (stopped) return;
    cancelTimer?.();
    cancelTimer = deps.setTimer(launchScan, ms);
  };
  const watch = (run: RunState) => {
    if (watches.has(run.runId) || stopped) return;
    const controller = new AbortController();
    watches.set(run.runId, controller);
    void deps
      .waitForTerminal(run.runId, controller.signal)
      .then(() => deps.readState(run.runId))
      .then((settled) => {
        if (stopped || !finished(settled)) return;
        track(cleanupTerminalRun(factory, settled, deps).then(() => undefined));
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          deps.warn(`[cleanup] watch ${run.runId} failed: ${String(error)}`);
      })
      .finally(() => watches.delete(run.runId));
  };
  const scan = async () => {
    if (stopped) return;
    if (!deps.ready()) {
      schedule(250);
      return;
    }
    try {
      const runs = await deps.pendingRuns();
      if (stopped) return;
      for (const run of runs) if (!finished(run)) watch(run);
      const report = await reconcileAutomaticRelease(
        factory,
        {
          ...deps,
          pendingRuns: async () => runs,
        },
        {
          canStart: () => !stopped,
        },
      );
      if (stopped) return;
      deps.log(
        `[cleanup] reconciled ${report.considered}: ${report.released} released, ${report.kept} kept, ${report.busy} active, ${report.failed} failed`,
      );
    } catch (error) {
      deps.warn(`[cleanup] reconciliation failed: ${String(error)}`);
    } finally {
      schedule();
    }
  };
  function launchScan() {
    if (stopped) return;
    track(scan());
  }
  launchScan();
  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopped = true;
    cancelTimer?.();
    for (const controller of watches.values()) controller.abort();
    watches.clear();
    // Aborted waiters are deliberately not awaited: a World implementation
    // may ignore AbortSignal. Every scan or destructive attempt admitted
    // before stopped flipped is tracked and must drain before World shutdown.
    stopPromise = Promise.allSettled([...tasks]).then(() => undefined);
    return stopPromise;
  };
  onShutdown(stop, { phase: "quiesce" });
  return { stop };
}

/** The service's real operations: this factory's registry rows and the configured World. */
export function automaticReleaseDeps(): AutomaticReleaseDeps {
  const readState = (runId: string) =>
    readRunState(registrySql(), currentFactory(), runId, worldRunFacts);
  return {
    pendingRuns: async () => {
      const rows = await listResources(registrySql(), {
        factory: currentFactory(),
        states: ["live", "failed"],
      });
      const runIds = new Set(rows.filter((row) => releasable(row.kind)).map((row) => row.runId));
      return Promise.all([...runIds].map(readState));
    },
    readState,
    waitForTerminal: async (runId, signal) => {
      const runs = (await getWorld()).runs;
      const wait = runs.waitForTerminalStatus;
      return wait === undefined
        ? runs.get(runId, { resolveData: "none" })
        : wait(runId, { resolveData: "none", timeoutMs: AUTOMATIC_RELEASE_INTERVAL_MS, signal });
    },
    hasActiveStep: async (runId) => (await runsWithActiveStep([runId])).length > 0,
    policy: (factory, run, outcome) =>
      automaticReleaseAction(
        factory,
        run.workflowName ?? "",
        outcome,
        readFactoryConfig(factoryRoot()).release,
      ),
    withLock: async (runId, action) => withRunResourceLock(registrySql(), runId, action),
    release: (sql, run, action, keepReason) =>
      releaseRun(sql, currentFactory(), run.runId, action, keepReason),
    ready: isReady,
    log: console.log,
    warn: console.error,
    setTimer: (fire, ms) => {
      const timer = setTimeout(fire, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}
