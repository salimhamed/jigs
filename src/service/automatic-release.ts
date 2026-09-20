/**
 * Reconcile resources that a completed factory run asked jigs to release automatically.
 *
 * @packageDocumentation
 */

import { getWorld } from "workflow/runtime";
import type { Factory } from "../blocks/factory.ts";
import {
  type CleanupAction,
  type CleanupOutcome,
  cleanupFromAttributes,
} from "../blocks/runtime/cleanup.ts";
import type { ReleasePolicy } from "../blocks/runtime/release.ts";
import { resourcesFromAttributes } from "../blocks/runtime/resources.ts";
import { readFactoryConfig } from "../config/factory-config.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";
import { writeCleanupProgress } from "../steps/runtime/cleanup-state.ts";
import { effectiveReleasePolicy, workflowReleasePolicy } from "../steps/runtime/release-policy.ts";
import {
  listWorktreesForRun,
  type RegistrySql,
  withRunResourceLock,
} from "../steps/workspaces/registry.ts";
import { releaseRunResources } from "../steps/workspaces/release.ts";
import { registrySql } from "../steps/workspaces/sql.ts";
import { isReady } from "./readiness.ts";
import { onShutdown } from "./shutdown.ts";
import { runsWithActiveStep } from "./stalls.ts";

export const AUTOMATIC_RELEASE_INTERVAL_MS = 60_000;

export interface CleanupRun {
  runId: string;
  status: string;
  workflowName: string;
  attributes: Record<string, string>;
}

export interface AutomaticReleaseDeps {
  listRuns: () => Promise<CleanupRun[]>;
  waitForTerminal: (runId: string, signal: AbortSignal) => Promise<CleanupRun>;
  hasActiveStep: (runId: string) => Promise<boolean>;
  policy: (factory: Factory, run: CleanupRun, outcome: CleanupOutcome) => CleanupAction;
  withLock: <T>(runId: string, action: (sql: RegistrySql) => Promise<T>) => Promise<T>;
  worktreeCount: (runId: string, sql: RegistrySql) => Promise<number>;
  release: (
    run: CleanupRun,
    action: CleanupAction,
    outcome: CleanupOutcome,
    sql: RegistrySql,
  ) => Promise<{
    worktrees: Array<{ removed: boolean; reason: string }>;
    runDirectory: { removed: boolean };
  }>;
  writeProgress: typeof writeCleanupProgress;
  ready: () => boolean;
  log: (line: string) => void;
  warn: (line: string) => void;
  setTimer: (fire: () => void, ms: number) => () => void;
}

export interface AutomaticReleaseReport {
  considered: number;
  released: number;
  kept: number;
  busy: number;
  failed: number;
}

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
  deps: AutomaticReleaseDeps = defaultDeps(),
  options: { canStart?: () => boolean } = {},
): Promise<AutomaticReleaseReport> {
  const report: AutomaticReleaseReport = {
    considered: 0,
    released: 0,
    kept: 0,
    busy: 0,
    failed: 0,
  };
  const runs = (await deps.listRuns()).filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
  for (const run of runs) {
    if (options.canStart?.() === false) break;
    const prior = cleanupFromAttributes(run.attributes);
    if (prior.status === "complete" || prior.status === "kept") continue;
    report.considered += 1;
    const result = await cleanupTerminalRun(factory, run, deps);
    report[result] += 1;
  }
  return report;
}

async function cleanupTerminalRun(
  factory: Factory,
  run: CleanupRun,
  deps: AutomaticReleaseDeps,
): Promise<"released" | "kept" | "busy" | "failed"> {
  const outcome: CleanupOutcome = run.status === "completed" ? "success" : "failure";
  const recorded = cleanupFromAttributes(run.attributes).directive;
  const action: CleanupAction =
    recorded === "automatic" ? deps.policy(factory, run, outcome) : recorded;
  const resources = resourcesFromAttributes(run.attributes);
  const unknown = resources.filter(
    (resource) => resource.kind !== "worktree" && resource.kind !== "run-directory",
  ).length;

  if (await deps.hasActiveStep(run.runId)) return "busy";
  try {
    return await deps.withLock(run.runId, async (sql) => {
      // Cancellation can settle the run before its active step completes.
      // Recheck after acquiring the same lock provisioning holds.
      if (await deps.hasActiveStep(run.runId)) return "busy";
      const worktrees = await deps.worktreeCount(run.runId, sql);
      await deps.writeProgress(run.runId, { status: "running", outcome, action, unknown });
      if (action === "keep") {
        await deps.writeProgress(run.runId, {
          status: "kept",
          outcome,
          action,
          released: 0,
          kept:
            worktrees + resources.filter((resource) => resource.kind === "run-directory").length,
          failed: 0,
          unknown,
        });
        return "kept";
      }

      const released = await deps.release(run, action, outcome, sql);
      const failed = released.worktrees.filter((resource) =>
        resource.reason.startsWith("release incomplete"),
      ).length;
      const removed =
        released.worktrees.filter((resource) => resource.removed).length +
        (released.runDirectory.removed ? 1 : 0);
      const kept =
        released.worktrees.length - failed - released.worktrees.filter((r) => r.removed).length;
      await deps.writeProgress(run.runId, {
        status: failed === 0 ? "complete" : "failed",
        outcome,
        action,
        released: removed,
        kept,
        failed,
        unknown,
      });
      return failed === 0 ? "released" : "failed";
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await deps
      .writeProgress(run.runId, { status: "failed", outcome, action, unknown, detail })
      .catch(() => undefined);
    deps.warn(`[cleanup] run ${run.runId} failed: ${detail}`);
    return "failed";
  }
}

/** Start notification-fast cleanup with polling recovery and restart reconciliation. */
export function startAutomaticRelease(
  factory: Factory,
  deps: AutomaticReleaseDeps = defaultDeps(),
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
  const watch = (run: CleanupRun) => {
    if (watches.has(run.runId) || stopped) return;
    const controller = new AbortController();
    watches.set(run.runId, controller);
    void deps
      .waitForTerminal(run.runId, controller.signal)
      .then((settled) => {
        if (stopped || !TERMINAL_RUN_STATUSES.has(settled.status)) return;
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
      const runs = await deps.listRuns();
      if (stopped) return;
      for (const run of runs) if (!TERMINAL_RUN_STATUSES.has(run.status)) watch(run);
      const report = await reconcileAutomaticRelease(
        factory,
        {
          ...deps,
          listRuns: async () => runs,
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

function defaultDeps(): AutomaticReleaseDeps {
  return {
    listRuns: listAllRuns,
    waitForTerminal: async (runId, signal) => {
      const runs = (await getWorld()).runs;
      const wait = runs.waitForTerminalStatus;
      return (
        wait === undefined
          ? runs.get(runId, { resolveData: "none" })
          : wait(runId, { resolveData: "none", timeoutMs: AUTOMATIC_RELEASE_INTERVAL_MS, signal })
      ) as Promise<CleanupRun>;
    },
    hasActiveStep: async (runId) => (await runsWithActiveStep([runId])).length > 0,
    policy: (factory, run, outcome) => {
      return automaticReleaseAction(
        factory,
        run.workflowName,
        outcome,
        readFactoryConfig(factoryRoot()).release,
      );
    },
    withLock: async (runId, action) => withRunResourceLock(registrySql(), runId, action),
    worktreeCount: async (runId, sql) => (await listWorktreesForRun(sql, runId)).length,
    release: async (run, action, outcome, sql) =>
      releaseRunResources(
        { onSuccess: action, onFailure: action },
        { workflowRunId: run.runId },
        sql,
        outcome,
      ),
    writeProgress: (runId, progress) => writeCleanupProgress(runId, progress),
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

async function listAllRuns(): Promise<CleanupRun[]> {
  const runs = (await getWorld()).runs;
  const result: CleanupRun[] = [];
  let cursor: string | undefined;
  do {
    const page = await runs.list({
      resolveData: "none",
      pagination: { limit: 1000, ...(cursor === undefined ? {} : { cursor }) },
    });
    result.push(...(page.data as CleanupRun[]));
    cursor = page.hasMore && page.cursor !== null ? page.cursor : undefined;
    if (!page.hasMore) break;
  } while (cursor !== undefined);
  return result;
}
