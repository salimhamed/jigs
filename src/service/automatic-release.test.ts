import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { afterEach, expect, test, vi } from "vitest";
import { setWorld } from "workflow/runtime";
import { z } from "zod";
import type { RegistrySql } from "../steps/runtime/registry.ts";
import type { Factory } from "../workflow/factory.ts";
import type { ResourceRecord, RunState } from "../workflow/runtime/resources.ts";
import {
  type AutomaticReleaseDeps,
  automaticReleaseAction,
  type CleanupAction,
  type CleanupOutcome,
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

function run(status: string): RunState {
  return {
    runId: `wrun_${status}`,
    status,
    workflowName: "workflow//./workflows/ship//ship",
    resources: [],
    claim: null,
    waitingOn: [],
  };
}

const record = (runId: string, state: ResourceRecord["state"]): ResourceRecord => ({
  runId,
  kind: "run-directory",
  identity: runId,
  url: `file:///scratch/${runId}`,
  state,
  reason: null,
  updatedAt: "2026-09-04T10:00:00.000Z",
});

// A run stays pending until a release attempt leaves none of its records live
// or failed, which is what the registry query behind pendingRuns answers.
function harness(
  runs: RunState[],
  options: {
    action?: (outcome: CleanupOutcome) => CleanupAction;
    active?: () => boolean;
    release?: AutomaticReleaseDeps["release"];
  } = {},
) {
  const settled = new Set<string>();
  const release = vi.fn(
    options.release ??
      (async (_sql: RegistrySql, target: RunState, action: CleanupAction) => [
        record(target.runId, action === "keep" ? "kept" : "released"),
      ]),
  );
  const deps: AutomaticReleaseDeps = {
    pendingRuns: async () => runs.filter((candidate) => !settled.has(candidate.runId)),
    readState: async (runId) => runs.find((candidate) => candidate.runId === runId) as RunState,
    waitForTerminal: async () => {
      throw new Error("unused");
    },
    hasActiveStep: async () => options.active?.() ?? false,
    policy: (_factory, _run, outcome) => options.action?.(outcome) ?? "release",
    withLock: async (_runId, action) => action({} as RegistrySql),
    release: async (...args) => {
      const records = await release(...args);
      if (records.every((entry) => entry.state !== "failed")) settled.add(args[1].runId);
      return records;
    },
    ready: () => true,
    log: vi.fn(),
    warn: vi.fn(),
    setTimer: () => () => undefined,
  };
  return { deps, release };
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
  expect(h.release.mock.calls.map((call) => [call[2], call[3]])).toEqual([
    ["release", "onSuccess policy keeps run resources"],
    ["keep", "onFailure policy keeps run resources"],
    ["keep", "onFailure policy keeps run resources"],
  ]);
});

test("a run that is still running or suspended is never released", async () => {
  const h = harness([run("running"), run("pending")]);

  expect((await reconcileAutomaticRelease(factory, h.deps)).considered).toBe(0);
  expect(h.release).not.toHaveBeenCalled();
});

test("a run the World no longer knows is released by its failure policy", async () => {
  const lost = { ...run("lost"), status: null, workflowName: null };
  const seen: CleanupOutcome[] = [];
  const h = harness([lost], {
    action: (outcome) => {
      seen.push(outcome);
      return "keep";
    },
  });

  expect((await reconcileAutomaticRelease(factory, h.deps)).kept).toBe(1);
  expect(seen).toEqual(["failure"]);
});

test("active work is checked again under the lock before cleanup", async () => {
  const observations = [false, true];
  const h = harness([run("cancelled")], { active: () => observations.shift() ?? false });

  expect((await reconcileAutomaticRelease(factory, h.deps)).busy).toBe(1);
  expect(h.release).not.toHaveBeenCalled();
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
});

test("a run busy on one pass is released on the next", async () => {
  let active = true;
  const h = harness([run("cancelled")], { action: () => "release", active: () => active });

  expect((await reconcileAutomaticRelease(factory, h.deps)).busy).toBe(1);
  active = false;
  expect((await reconcileAutomaticRelease(factory, h.deps)).released).toBe(1);
  expect((await reconcileAutomaticRelease(factory, h.deps)).considered).toBe(0);
});

test("transient failures stay visible and retry on the next reconciliation", async () => {
  const terminal = run("completed");
  let attempt = 0;
  const h = harness([terminal], {
    release: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary database failure");
      if (attempt === 2) return [record(terminal.runId, "failed")];
      return [record(terminal.runId, "released")];
    },
  });

  expect((await reconcileAutomaticRelease(factory, h.deps)).failed).toBe(1);
  expect(h.deps.warn).toHaveBeenCalledWith(
    "[cleanup] run wrun_completed failed: temporary database failure",
  );
  expect((await reconcileAutomaticRelease(factory, h.deps)).failed).toBe(1);
  expect((await reconcileAutomaticRelease(factory, h.deps)).released).toBe(1);
});

test("a terminal notification racing stop cannot admit new cleanup", async () => {
  const running = run("running");
  const notification = deferred<unknown>();
  const waiting = vi.fn(() => notification.promise);
  const h = harness([running]);
  h.deps.waitForTerminal = waiting;

  const coordinator = startAutomaticRelease(factory, h.deps);
  await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
  await coordinator.stop();
  running.status = "completed";
  notification.resolve(undefined);
  await Promise.resolve();
  await Promise.resolve();

  expect(h.release).not.toHaveBeenCalled();
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

  release.resolve([record("wrun_completed", "released")]);
  await stopping;
  expect(stopped).toBe(true);
});

test("timer reconciliation is tracked and cancelled during shutdown", async () => {
  const runs: RunState[] = [];
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
});

test("a failed in-flight scan cannot wedge shutdown", async () => {
  const listed = deferred<RunState[]>();
  const h = harness([]);
  h.deps.pendingRuns = () => listed.promise;
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
