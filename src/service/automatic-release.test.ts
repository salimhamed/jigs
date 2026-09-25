import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { afterEach, expect, test, vi } from "vitest";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import type { RegistrySql } from "../steps/workspaces/registry.ts";
import type { Factory } from "../workflow/factory.ts";
import {
  CLEANUP_DIRECTIVE_ATTRIBUTE,
  CLEANUP_STATE_ATTRIBUTE,
  type CleanupAction,
  type CleanupOutcome,
  encodeCleanupProgress,
} from "../workflow/runtime/cleanup.ts";
import { resourceAttribute } from "../workflow/runtime/resources.ts";
import {
  type AutomaticReleaseDeps,
  automaticReleaseAction,
  type CleanupRun,
  reconcileAutomaticRelease,
  startAutomaticRelease,
} from "./automatic-release.ts";
import { runsWithActiveStep } from "./stalls.ts";

const factory = { workflows: {} } as Factory;

afterEach(() => setWorld(undefined));

test("workflow policy overrides the factory policy for automatic cleanup", () => {
  const workflow = Object.assign(async () => undefined, {
    workflowId: "workflow//./workflows/ship//ship",
  });
  const configured = {
    workflows: {
      ship: {
        workflow,
        inputs: z.object({}),
        release: { onSuccess: "keep", onFailure: "release" },
      },
    },
  } satisfies Factory;
  const factoryPolicy = { onSuccess: "release", onFailure: "keep" } as const;

  expect(automaticReleaseAction(configured, workflow.workflowId, "success", factoryPolicy)).toBe(
    "keep",
  );
  expect(automaticReleaseAction(configured, workflow.workflowId, "failure", factoryPolicy)).toBe(
    "release",
  );
});

function run(status: CleanupRun["status"], attributes: Record<string, string> = {}): CleanupRun {
  return {
    runId: `wrun_${status}`,
    status,
    workflowName: "workflow//./workflows/ship//ship",
    attributes: {
      [CLEANUP_DIRECTIVE_ATTRIBUTE]: "automatic",
      [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({ status: "waiting" }),
      ...attributes,
    },
  };
}

function harness(
  runs: CleanupRun[],
  options: {
    action?: (outcome: CleanupOutcome) => CleanupAction;
    active?: () => boolean;
    release?: AutomaticReleaseDeps["release"];
    worktrees?: number;
  } = {},
) {
  const progress: Array<{
    runId: string;
    value: Parameters<AutomaticReleaseDeps["writeProgress"]>[1];
  }> = [];
  const release = vi.fn(
    options.release ??
      (async () => ({
        worktrees: [{ removed: true, reason: "worktree released" }],
        runDirectory: { removed: true },
      })),
  );
  const deps: AutomaticReleaseDeps = {
    listRuns: async () => runs,
    waitForTerminal: async () => {
      throw new Error("unused");
    },
    hasActiveStep: async () => options.active?.() ?? false,
    policy: (_factory, _run, outcome) => options.action?.(outcome) ?? "release",
    withLock: async (_runId, action) => action({} as RegistrySql),
    worktreeCount: async () => options.worktrees ?? 1,
    release,
    writeProgress: async (runId, value) => {
      progress.push({ runId, value });
      const target = runs.find((candidate) => candidate.runId === runId);
      if (target) target.attributes[CLEANUP_STATE_ATTRIBUTE] = encodeCleanupProgress(value);
    },
    ready: () => true,
    log: vi.fn(),
    warn: vi.fn(),
    setTimer: () => () => undefined,
  };
  return { deps, progress, release };
}

test("completed runs release while failed and cancelled runs use the failure policy", async () => {
  const runs = [run("completed"), run("failed"), run("cancelled")];
  const seen: CleanupOutcome[] = [];
  const h = harness(runs, {
    action: (outcome) => {
      seen.push(outcome);
      return outcome === "success" ? "release" : "keep";
    },
  });

  expect(await reconcileAutomaticRelease(factory, h.deps)).toEqual({
    considered: 3,
    released: 1,
    kept: 2,
    busy: 0,
    failed: 0,
  });
  expect(seen).toEqual(["success", "failure", "failure"]);
  expect(h.release).toHaveBeenCalledTimes(1);
});

test("an explicit keep remains authoritative over later automatic policy", async () => {
  const kept = run("completed", { [CLEANUP_DIRECTIVE_ATTRIBUTE]: "keep" });
  const h = harness([kept]);

  expect((await reconcileAutomaticRelease(factory, h.deps)).kept).toBe(1);
  expect(h.release).not.toHaveBeenCalled();
  expect(h.progress.at(-1)?.value).toMatchObject({ status: "kept", action: "keep" });
});

test("suspended PR gates and a merely recorded PR never trigger cleanup", async () => {
  const pr = resourceAttribute({
    kind: "pull-request",
    identity: "acme/api#7",
    url: "https://github.com/acme/api/pull/7",
  });
  const h = harness([run("running", { [pr.key]: pr.value })]);

  expect((await reconcileAutomaticRelease(factory, h.deps)).considered).toBe(0);
  expect(h.release).not.toHaveBeenCalled();
});

test("merged and closed-without-merge terminal outcomes both follow their mapped policy", async () => {
  const merged = run("completed");
  const closed = run("failed");
  const h = harness([merged, closed], { action: () => "release" });

  expect(await reconcileAutomaticRelease(factory, h.deps)).toMatchObject({ released: 2 });
  expect(h.release.mock.calls.map((call) => call[2])).toEqual(["success", "failure"]);
});

test("active work is checked again under the lock before cleanup", async () => {
  const observations = [false, true];
  const h = harness([run("cancelled")], { active: () => observations.shift() ?? false });

  expect((await reconcileAutomaticRelease(factory, h.deps)).busy).toBe(1);
  expect(h.release).not.toHaveBeenCalled();
  expect(h.progress).toEqual([]);
});

test("a later-page active step keeps the cleanup coordinator busy under the lock", async () => {
  const terminal = run("cancelled");
  const completed = {
    runId: terminal.runId,
    stepId: "step-completed",
    stepName: "completed",
    status: "completed",
    attempt: 1,
    createdAt: new Date("2026-09-04T10:00:00.000Z"),
    updatedAt: new Date("2026-09-04T10:00:01.000Z"),
    startedAt: new Date("2026-09-04T10:00:00.000Z"),
    completedAt: new Date("2026-09-04T10:00:01.000Z"),
  };
  const active = { ...completed, stepId: "step-active", status: "running" };
  let check = 0;
  let activeCheck = false;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    steps: {
      list: async (params: { pagination?: { cursor?: string } }) => {
        if (params.pagination?.cursor === undefined) {
          activeCheck = ++check > 1;
          return { data: [completed], cursor: "later", hasMore: true };
        }
        return { data: [activeCheck ? active : completed], cursor: null, hasMore: false };
      },
    },
  } as never);
  const h = harness([terminal]);
  h.deps.hasActiveStep = async (runId) => (await runsWithActiveStep([runId])).length > 0;

  expect((await reconcileAutomaticRelease(factory, h.deps)).busy).toBe(1);
  expect(h.release).not.toHaveBeenCalled();
  expect(h.progress).toEqual([]);
});

test("a later-page listing failure cannot authorize cleanup", async () => {
  const terminal = run("cancelled");
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    steps: {
      list: async (params: { pagination?: { cursor?: string } }) => {
        if (params.pagination?.cursor !== undefined) throw new Error("later page unavailable");
        return { data: [], cursor: "later", hasMore: true };
      },
    },
  } as never);
  const h = harness([terminal]);
  h.deps.hasActiveStep = async (runId) => (await runsWithActiveStep([runId])).length > 0;

  await expect(reconcileAutomaticRelease(factory, h.deps)).rejects.toThrow(
    "later page unavailable",
  );
  expect(h.release).not.toHaveBeenCalled();
  expect(h.progress).toEqual([]);
});

test("a resource registered after cancellation is discovered on retry", async () => {
  const cancelled = run("cancelled");
  let active = true;
  let worktrees = 0;
  const h = harness([cancelled], {
    action: () => "release",
    active: () => active,
    worktrees,
    release: async () => ({
      worktrees: Array.from({ length: worktrees }, () => ({
        removed: true,
        reason: "worktree released",
      })),
      runDirectory: { removed: false },
    }),
  });

  expect((await reconcileAutomaticRelease(factory, h.deps)).busy).toBe(1);
  worktrees = 1;
  active = false;
  expect((await reconcileAutomaticRelease(factory, h.deps)).released).toBe(1);
  expect(h.release.mock.results.at(-1)?.value).toBeInstanceOf(Promise);
  expect(h.progress.at(-1)?.value).toMatchObject({ released: 1, status: "complete" });
});

test("duplicate signals and already-released runs are idempotent", async () => {
  const done = run("completed", {
    [CLEANUP_STATE_ATTRIBUTE]: encodeCleanupProgress({
      status: "complete",
      outcome: "success",
      action: "release",
      released: 0,
      kept: 0,
      failed: 0,
      unknown: 0,
    }),
  });
  const h = harness([done]);

  expect((await reconcileAutomaticRelease(factory, h.deps)).considered).toBe(0);
  expect(h.release).not.toHaveBeenCalled();
});

test("transient failures stay visible and retry on the next reconciliation", async () => {
  const terminal = run("completed");
  let attempt = 0;
  const h = harness([terminal], {
    release: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary git failure");
      return { worktrees: [], runDirectory: { removed: true } };
    },
  });

  expect((await reconcileAutomaticRelease(factory, h.deps)).failed).toBe(1);
  expect(h.progress.at(-1)?.value).toMatchObject({ status: "failed" });
  expect((await reconcileAutomaticRelease(factory, h.deps)).released).toBe(1);
  expect(h.progress.at(-1)?.value).toMatchObject({ status: "complete" });
});

test("unknown resource kinds remain visible and are counted without dispatch", async () => {
  const unknown = resourceAttribute({
    kind: "report",
    identity: "summary",
    url: "https://example.test/report",
  });
  const h = harness([run("completed", { [unknown.key]: unknown.value })]);

  await reconcileAutomaticRelease(factory, h.deps);
  expect(h.progress.at(-1)?.value).toMatchObject({ status: "complete", unknown: 1 });
  expect(h.release).toHaveBeenCalledTimes(1);
});

test("a terminal notification racing stop cannot admit new cleanup", async () => {
  const running = run("running");
  const terminal = { ...running, status: "completed" };
  const notification = deferred<CleanupRun>();
  const waiting = vi.fn(() => notification.promise);
  const h = harness([running]);
  h.deps.waitForTerminal = waiting;

  const coordinator = startAutomaticRelease(factory, h.deps);
  await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
  await coordinator.stop();
  notification.resolve(terminal);
  await Promise.resolve();
  await Promise.resolve();

  expect(h.release).not.toHaveBeenCalled();
  expect(h.progress).toEqual([]);
});

test("stop drains a destructive attempt already admitted by startup reconciliation", async () => {
  const release = deferred<Awaited<ReturnType<AutomaticReleaseDeps["release"]>>>();
  const h = harness([run("completed")], { release: () => release.promise });
  const coordinator = startAutomaticRelease(factory, h.deps);
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());

  let stopped = false;
  const stopping = coordinator.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);

  release.resolve({
    worktrees: [{ removed: true, reason: "worktree released" }],
    runDirectory: { removed: true },
  });
  await stopping;
  expect(stopped).toBe(true);
  expect(h.progress.at(-1)?.value.status).toBe("complete");
});

test("timer reconciliation is tracked and cancelled during shutdown", async () => {
  const runs: CleanupRun[] = [];
  const h = harness(runs);
  let fire: (() => void) | undefined;
  const cancel = vi.fn();
  h.deps.setTimer = (scheduled) => {
    fire = scheduled;
    return cancel;
  };
  const coordinator = startAutomaticRelease(factory, h.deps);
  await vi.waitFor(() => expect(fire).toBeTypeOf("function"));

  runs.push(run("completed"));
  fire?.();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  await coordinator.stop();

  expect(cancel).toHaveBeenCalled();
  expect(h.progress.at(-1)?.value.status).toBe("complete");
});

test("a failed in-flight scan cannot wedge shutdown", async () => {
  const listed = deferred<CleanupRun[]>();
  const h = harness([]);
  h.deps.listRuns = () => listed.promise;
  const coordinator = startAutomaticRelease(factory, h.deps);
  const stopping = coordinator.stop();

  listed.reject(new Error("World closed early"));

  await expect(stopping).resolves.toBeUndefined();
  expect(h.deps.warn).toHaveBeenCalledWith(
    "[cleanup] reconciliation failed: Error: World closed early",
  );
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
