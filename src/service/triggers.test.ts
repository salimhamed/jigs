import { afterAll, expect, test, vi } from "vitest";
import { z } from "zod";
import type { CheckReport } from "../checks/index.ts";
import type { EventTrigger, Factory } from "../workflow/factory.ts";
import { eventTriggerId, type RunRow } from "./runs.ts";
import type { Source, SourceEvent, SourceRegistry } from "./sources.ts";
import type { PreparedRun } from "./trigger.ts";
import type { Occurrence, TriggerMarker, TriggerStore } from "./trigger-store.ts";
import {
  createTriggerEngine,
  listTriggers,
  startTriggers,
  type TriggerDeps,
  triggerChecks,
} from "./triggers.ts";

const ambientWorkflowEnv = vi.hoisted(() => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  const postgresUrl = process.env.WORKFLOW_POSTGRES_URL;
  delete process.env.WORKFLOW_TARGET_WORLD;
  delete process.env.WORKFLOW_POSTGRES_URL;
  return { targetWorld, postgresUrl };
});

afterAll(() => {
  if (ambientWorkflowEnv.targetWorld === undefined) delete process.env.WORKFLOW_TARGET_WORLD;
  else process.env.WORKFLOW_TARGET_WORLD = ambientWorkflowEnv.targetWorld;
  if (ambientWorkflowEnv.postgresUrl === undefined) delete process.env.WORKFLOW_POSTGRES_URL;
  else process.env.WORKFLOW_POSTGRES_URL = ambientWorkflowEnv.postgresUrl;
});

const T0 = new Date("2026-09-29T12:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

// A source whose provider hands back whatever the test queued, and whose
// pushed events are `{ page }` objects.
function fakeSource() {
  const queued: SourceEvent[] = [];
  const polls: Date[] = [];
  const source: Source<{ service: string }> = {
    provider: "github",
    params: z.object({ service: z.string() }),
    sampleInputs: { page: "P0" },
    occurrence: (inputs) => {
      if (typeof inputs.page !== "string") throw new Error("no page id in the event");
      return inputs.page;
    },
    poll: async (_params, since) => {
      polls.push(since);
      return queued.splice(0);
    },
    fromPush: (_params, event) => {
      const page = (event as { page?: unknown }).page;
      return typeof page === "string" ? { inputs: { page }, at: minutes(1) } : null;
    },
  };
  return { source, queued, polls };
}

function memoryStore() {
  const rows = new Map<string, Occurrence>();
  const marks = new Map<string, TriggerMarker>();
  const key = (trigger: string, occurrence: string) => `${trigger}\0${occurrence}`;
  const settle = (trigger: string, occurrence: string, patch: Partial<Occurrence>) => {
    const row = rows.get(key(trigger, occurrence));
    if (row?.state === "pending") rows.set(key(trigger, occurrence), { ...row, ...patch });
  };
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
        settledAt: null,
        report: null,
        updatedAt: T0,
      });
      return true;
    },
    pending: async (trigger) =>
      [...rows.values()]
        .filter((row) => row.trigger === trigger && row.state === "pending")
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
    attempt: async (trigger, occurrence, runId, at, options = {}) => {
      const row = rows.get(key(trigger, occurrence));
      if (row?.state !== "pending")
        throw new Error(`${trigger} ${occurrence} is no longer pending`);
      const attempted = options.renew
        ? { attemptedAt: at, runId }
        : { attemptedAt: row.attemptedAt ?? at, runId: row.runId ?? runId };
      rows.set(key(trigger, occurrence), { ...row, ...attempted });
      return attempted as { attemptedAt: Date; runId: string };
    },
    unsettled: async (trigger) =>
      [...rows.values()]
        .filter(
          (row) => row.trigger === trigger && row.state === "started" && row.settledAt === null,
        )
        .map((row) => ({ ...row, startedAt: row.updatedAt })),
    settle: async (trigger, occurrence) => {
      const row = rows.get(key(trigger, occurrence));
      if (row?.state === "started") rows.set(key(trigger, occurrence), { ...row, settledAt: T0 });
    },
    started: async (trigger, occurrence, runId) =>
      settle(trigger, occurrence, { state: "started", runId }),
    failed: async (trigger, occurrence, report) =>
      settle(trigger, occurrence, { state: "failed", report }),
    summary: async (trigger) => {
      const mine = [...rows.values()].filter((row) => row.trigger === trigger);
      return {
        lastEvent: null,
        pending: mine.filter((row) => row.state === "pending" && row.attemptedAt === null).length,
        attempted: mine.filter((row) => row.state === "pending" && row.attemptedAt !== null).length,
        failed: mine.filter((row) => row.state === "failed").length,
        failures: mine.filter((row) => row.state === "failed"),
      };
    },
  };
  const state = (trigger: string, occurrence: string) => rows.get(key(trigger, occurrence));
  return { store, rows, marks, state };
}

const factory = (triggers: Record<string, EventTrigger>): Factory => ({
  workflows: {
    respond: {
      workflow: async () => undefined,
      inputs: z.object({ page: z.string(), team: z.string() }),
    },
  },
  triggers,
});

const pagesTrigger: EventTrigger = {
  workflow: "respond",
  source: { kind: "fake.pages", params: { service: "api" } },
  inputs: { team: "infra" },
};

let runCounter = 0;
const nextRunId = () => `wrun_${String(++runCounter).padStart(26, "0")}`;

// What the World holds, as far as the engine reads it: each run's status by
// ID. No inputs at all, as if the World encrypted every one.
interface FakeRun {
  runId: string;
  status: string;
}

function harness(
  options: {
    trigger?: EventTrigger;
    triggers?: Record<string, EventTrigger>;
    runs?: FakeRun[];
    prepare?: TriggerDeps["prepareRun"];
    /** The World call; the run it creates is pending, unless `createsRun` is false. */
    launch?: (inputs: unknown, triggerId: string, runId: string) => Promise<void>;
    createsRun?: boolean;
    enqueue?: TriggerDeps["enqueueRun"];
    store?: TriggerStore;
  } = {},
) {
  const { source, queued, polls } = fakeSource();
  const memory = memoryStore();
  const lines: string[] = [];
  const starts: Array<{ inputs: unknown; triggerId: string; runId?: string }> = [];
  const runs = options.runs ?? [];
  const enqueued: string[] = [];
  let clock = T0;
  const sources: SourceRegistry = { "fake.pages": source };
  const deps = {
    store: options.store ?? memory.store,
    sources,
    now: () => clock,
    log: (line: string) => lines.push(line),
    factorySlug: () => "factory-a",
    runStatuses: async (ids: readonly string[]) =>
      new Map(runs.filter((run) => ids.includes(run.runId)).map((run) => [run.runId, run.status])),
    // A run created under the caller's ID is pending until it is queued.
    prepareRun:
      options.prepare ??
      (async (_factory: Factory, _workflow: string, inputs: unknown): Promise<PreparedRun> => ({
        kind: "ready",
        launch: async (triggerId, runId) => {
          starts.push({ inputs, triggerId, runId });
          await options.launch?.(inputs, triggerId, runId as string);
          const id = runId ?? nextRunId();
          if (options.createsRun !== false && !runs.some((run) => run.runId === id))
            runs.push({ runId: id, status: "pending" });
          return id;
        },
      })),
    enqueueRun:
      options.enqueue ??
      (async (runId: string) => {
        enqueued.push(runId);
        const run = runs.find((candidate) => candidate.runId === runId);
        if (run?.status === "pending") run.status = "running";
      }),
  } satisfies TriggerDeps;
  const engine = createTriggerEngine(
    factory(options.triggers ?? { pages: options.trigger ?? pagesTrigger }),
    deps,
  );
  return {
    engine,
    deps,
    queued,
    polls,
    memory,
    lines,
    starts,
    runs,
    enqueued,
    sources,
    at: (next: Date) => {
      clock = next;
    },
  };
}

const event = (page: string, at: Date): SourceEvent => ({ inputs: { page }, at });

test("an occurrence seen twice, polled then pushed, starts one run", async () => {
  const h = harness();
  await h.engine.arm();
  h.at(minutes(2));
  h.queued.push(event("P1", minutes(1)));
  await h.engine.poll("pages");
  expect(await h.engine.push("github", { page: "P1" })).toEqual([]);
  h.queued.push(event("P1", minutes(1)));
  await h.engine.poll("pages");
  await h.engine.drain();

  expect(h.starts).toEqual([
    {
      inputs: { team: "infra", page: "P1" },
      triggerId: eventTriggerId("pages", "P1"),
      runId: h.memory.state("pages", "P1")?.runId,
    },
  ]);
  expect(h.memory.state("pages", "P1")).toMatchObject({
    state: "started",
    runId: h.runs[0]?.runId,
  });
});

test("a pushed event is recorded and started, and answers before the run starts", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    launch: async () => {
      await gate;
    },
  });
  await h.engine.arm();
  h.at(minutes(2));

  expect(await h.engine.push("github", { page: "P7" })).toEqual(["pages"]);
  expect(h.memory.state("pages", "P7")?.state).toBe("pending");
  release();
  await h.engine.drain();
  expect(h.memory.state("pages", "P7")?.state).toBe("started");
});

test("a push for another provider, or not an occurrence, is not taken", async () => {
  const h = harness();
  await h.engine.arm();
  expect(await h.engine.push("linear", { page: "P1" })).toEqual([]);
  expect(await h.engine.push("github", { other: true })).toEqual([]);
  expect(h.memory.rows.size).toBe(0);
});

test("a leftover pending row whose run never started is started once armed", async () => {
  const h = harness();
  await h.memory.store.enable("pages", minutes(-60));
  await h.memory.store.record({
    trigger: "pages",
    occurrence: "P2",
    state: "pending",
    inputs: { page: "P2" },
    occurredAt: minutes(-5),
  });

  await h.engine.arm();
  await h.engine.drain();

  expect(h.starts.map((start) => start.triggerId)).toEqual([eventTriggerId("pages", "P2")]);
  expect(h.memory.state("pages", "P2")?.state).toBe("started");
});

const leftover = async (store: TriggerStore, occurrence: string) => {
  await store.enable("pages", minutes(-60));
  await store.record({
    trigger: "pages",
    occurrence,
    state: "pending",
    inputs: { page: occurrence },
    occurredAt: minutes(-5),
  });
};

test("a run created but never queued is queued under its ID, not just marked started", async () => {
  // Salim's first case: the run exists, pending, and its delivery was lost.
  const runs: FakeRun[] = [];
  const failed = harness({
    runs,
    enqueue: async () => {
      throw new Error("queue unavailable");
    },
  });
  await leftover(failed.memory.store, "P3");
  await failed.engine.drain();
  const runId = failed.memory.state("pages", "P3")?.runId;
  expect(runs).toEqual([{ runId, status: "pending" }]);
  expect(failed.memory.state("pages", "P3")?.state).toBe("pending");

  // The next drain, here after a restart: same rows, same World.
  const h = harness({ runs, store: failed.memory.store });
  await h.engine.arm();
  await h.engine.drain();

  expect(h.starts.map((start) => start.runId)).toEqual([]);
  expect(h.enqueued).toEqual([runId]);
  expect(failed.memory.state("pages", "P3")).toMatchObject({ state: "started", runId });
});

test("a run seen past pending is marked started without being queued again", async () => {
  const runId = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
  const h = harness({ runs: [{ runId, status: "running" }] });
  await leftover(h.memory.store, "P3");
  await h.memory.store.attempt("pages", "P3", runId, T0);
  await h.engine.arm();
  await h.engine.drain();
  expect(h.enqueued).toEqual([]);
  expect(h.memory.state("pages", "P3")).toMatchObject({ state: "started", runId });
});

test("runs this trigger did not start do not count against its cap", async () => {
  const runs: FakeRun[] = [1, 2, 3].map(() => ({ runId: nextRunId(), status: "running" }));
  const h = harness({ runs, trigger: { ...pagesTrigger, maxActive: 1 } });
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("github", { page: "P1" });
  await h.engine.drain();
  expect(h.starts).toHaveLength(1);
});

test("past maxActive, occurrences wait and start oldest first as runs finish", async () => {
  const h = harness({ trigger: { ...pagesTrigger, maxActive: 2 } });
  await h.engine.arm();
  h.at(minutes(10));
  h.queued.push(
    event("P4", minutes(4)),
    event("P1", minutes(1)),
    event("P3", minutes(3)),
    event("P2", minutes(2)),
  );
  await h.engine.poll("pages");

  expect(h.starts.map((start) => start.triggerId)).toEqual([
    eventTriggerId("pages", "P1"),
    eventTriggerId("pages", "P2"),
  ]);
  expect(h.memory.state("pages", "P3")?.state).toBe("pending");
  expect(h.lines).toContain("[trigger] pages: 2 waiting, 2 of 2 runs active");

  const first = h.runs[0];
  if (first) first.status = "completed";
  await h.engine.drain();
  expect(h.starts.map((start) => start.triggerId).slice(2)).toEqual([
    eventTriggerId("pages", "P3"),
  ]);
  expect(h.memory.state("pages", "P4")?.state).toBe("pending");
});

test("the cap defaults to three", async () => {
  const h = harness();
  await h.engine.arm();
  h.at(minutes(10));
  h.queued.push(...["P1", "P2", "P3", "P4"].map((page, i) => event(page, minutes(i + 1))));
  await h.engine.poll("pages");
  expect(h.starts).toHaveLength(3);
});

test("a new trigger starts from now: nothing before its first enable is recorded", async () => {
  const h = harness();
  await h.engine.arm();
  h.queued.push(event("OLD", minutes(-1)), event("NEW", minutes(0)));
  await h.engine.poll("pages");

  expect(h.polls).toEqual([T0]);
  expect(h.memory.state("pages", "OLD")).toBeUndefined();
  expect(h.memory.state("pages", "NEW")?.state).toBe("started");
});

test("after downtime, occurrences past the lookback are skipped and recent ones start", async () => {
  const h = harness({ trigger: { ...pagesTrigger, lookbackMinutes: 30 } });
  await h.memory.store.enable("pages", minutes(-600));
  h.at(minutes(0));
  await h.engine.arm();
  h.queued.push(event("STALE", minutes(-45)), event("FRESH", minutes(-10)));
  await h.engine.poll("pages");

  expect(h.polls).toEqual([minutes(-600)]);
  expect(h.memory.state("pages", "STALE")?.state).toBe("skipped");
  expect(h.memory.state("pages", "FRESH")?.state).toBe("started");
  expect(h.starts).toHaveLength(1);
  expect(h.lines).toContain("[trigger] pages STALE skipped: older than its 30-minute lookback");
});

test("the lookback defaults to an hour", async () => {
  const h = harness();
  await h.memory.store.enable("pages", minutes(-600));
  await h.engine.arm();
  h.queued.push(event("A", minutes(-61)), event("B", minutes(-59)));
  await h.engine.poll("pages");
  expect(h.memory.state("pages", "A")?.state).toBe("skipped");
  expect(h.memory.state("pages", "B")?.state).toBe("started");
});

test("each poll reads from where the last one began", async () => {
  const h = harness();
  await h.engine.arm();
  h.at(minutes(5));
  await h.engine.poll("pages");
  h.at(minutes(10));
  await h.engine.poll("pages");
  expect(h.polls).toEqual([T0, minutes(5)]);
});

test("a failed poll leaves the window where it was", async () => {
  const h = harness();
  await h.engine.arm();
  const poll = h.sources["fake.pages"] as Source;
  const original = poll.poll;
  poll.poll = async () => {
    throw new Error("provider down");
  };
  h.at(minutes(5));
  await h.engine.poll("pages");
  poll.poll = original;
  h.at(minutes(10));
  await h.engine.poll("pages");
  expect(h.polls).toEqual([T0]);
  expect(h.lines).toContain("[trigger] pages poll failed: Error: provider down");
});

const preflightFailure: CheckReport = {
  ok: false,
  checks: [
    {
      id: "github.identity",
      label: "GitHub identity",
      ok: false,
      reason: "GITHUB_TOKEN is not set",
      repair: "set GITHUB_TOKEN in the factory repo's .env",
    },
  ],
};

test("a start that fails preflight is recorded failed with its report, and never retried", async () => {
  let calls = 0;
  const h = harness({
    prepare: async () => {
      calls += 1;
      return { kind: "preflight-failed", report: preflightFailure };
    },
  });
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("github", { page: "P5" });
  await h.engine.drain();
  await h.engine.drain();

  expect(calls).toBe(1);
  expect(h.memory.state("pages", "P5")).toMatchObject({
    state: "failed",
    report: preflightFailure,
  });
  expect(h.lines).toContain("[trigger] pages P5 failed: GitHub identity: GITHUB_TOKEN is not set");
});

test("inputs the workflow rejects at start are recorded failed with a repair", async () => {
  const h = harness({
    prepare: async () => ({
      kind: "invalid-inputs",
      issues: [{ code: "custom", path: ["team"], message: "Required", input: undefined }],
    }),
  });
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("github", { page: "P6" });
  await h.engine.drain();
  const report = h.memory.state("pages", "P6")?.report;
  expect(report?.checks[0]).toMatchObject({
    ok: false,
    reason: "invalid inputs: team Required",
    repair: "fix triggers.pages.inputs in jigs.config.ts to satisfy its workflow's inputs",
  });
});

test("a start that throws leaves the row pending for the next drain", async () => {
  let fail = true;
  const runs: FakeRun[] = [];
  const h = harness({
    runs,
    launch: async () => {
      if (fail) throw new Error("world unreachable");
    },
  });
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("github", { page: "P8" });
  await h.engine.drain();
  expect(h.memory.state("pages", "P8")?.state).toBe("pending");
  expect(h.lines).toContain(
    "[trigger] pages could not start waiting occurrences: Error: world unreachable",
  );
  const first = h.memory.state("pages", "P8")?.runId;
  expect(first).toMatch(/^wrun_[0-9A-HJKMNP-TV-Z]{26}$/);
  fail = false;
  // Nothing was queued for it, so the next drain creates it under the same ID.
  await h.engine.drain();
  expect(h.memory.state("pages", "P8")).toMatchObject({ state: "started", runId: first });
  expect(h.enqueued).toEqual([first]);
});

test("a preflight that throws is retried without an attempt, and keeps its own cause", async () => {
  let calls = 0;
  const h = harness({
    prepare: async () => {
      calls += 1;
      throw new Error("Linear unreachable");
    },
  });
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("github", { page: "P1" });
  await h.engine.drain();
  // The push's own drain, then this one: each a plain retry.
  expect(calls).toBe(2);
  expect(h.memory.state("pages", "P1")).toMatchObject({
    state: "pending",
    attemptedAt: null,
    runId: null,
  });
  expect(h.lines).toContain(
    "[trigger] pages could not start waiting occurrences: Error: Linear unreachable",
  );
});

test("an attempt whose run is not visible keeps its slot however long it waits", async () => {
  // Salim's second case: maxActive 1, the attempt's run not visible (its
  // creation failed retryably), an older occurrence arriving late.
  const tries: Array<string | undefined> = [];
  const h = harness({
    trigger: { ...pagesTrigger, maxActive: 1 },
    launch: async (_inputs, _triggerId, runId) => {
      tries.push(runId);
    },
    createsRun: false,
  });
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("github", { page: "P1" });
  await h.engine.drain();
  await h.memory.store.record({
    trigger: "pages",
    occurrence: "OLDER",
    state: "pending",
    inputs: { page: "OLDER" },
    occurredAt: minutes(-30),
  });
  h.at(minutes(45));
  await h.engine.drain();

  const runId = h.memory.state("pages", "P1")?.runId;
  // The push's drain, then two more: every try under the same ID.
  expect(tries).toEqual([runId, runId, runId]);
  expect(h.memory.state("pages", "P1")?.state).toBe("pending");
  expect(h.memory.state("pages", "OLDER")).toMatchObject({ state: "pending", attemptedAt: null });
  expect(h.lines).toContain("[trigger] pages: 1 waiting, 1 of 1 runs active");
});

test("an attempt older than the World's run ID window is created under a fresh ID", async () => {
  const stale = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
  const h = harness();
  await leftover(h.memory.store, "P1");
  await h.memory.store.attempt("pages", "P1", stale, minutes(-24 * 60));
  await h.engine.arm();
  await h.engine.drain();
  const row = h.memory.state("pages", "P1");
  expect(row?.state).toBe("started");
  expect(row?.runId).not.toBe(stale);
  expect(h.starts.map((start) => start.runId)).toEqual([row?.runId]);
});

test("a late older occurrence waits while a newer one's run is recovered first", async () => {
  // The reviewer's case: maxActive 1, the newer occurrence attempted with a
  // live run, the older one arriving after it.
  const live = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
  const h = harness({
    trigger: { ...pagesTrigger, maxActive: 1 },
    runs: [{ runId: live, status: "running" }],
  });
  await h.memory.store.enable("pages", minutes(-60));
  await h.memory.store.record({
    trigger: "pages",
    occurrence: "NEWER",
    state: "pending",
    inputs: { page: "NEWER" },
    occurredAt: minutes(-5),
  });
  await h.memory.store.attempt("pages", "NEWER", live, minutes(-4));
  await h.memory.store.record({
    trigger: "pages",
    occurrence: "OLDER",
    state: "pending",
    inputs: { page: "OLDER" },
    occurredAt: minutes(-10),
  });
  await h.engine.arm();
  await h.engine.drain();

  expect(h.starts).toEqual([]);
  expect(h.memory.state("pages", "NEWER")).toMatchObject({ state: "started", runId: live });
  expect(h.memory.state("pages", "OLDER")?.state).toBe("pending");
});

const gate = () => {
  let open: () => void = () => {};
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
};

test("a push after a restart answers without waiting for the leftover backlog to start", async () => {
  const { shut, open } = gate();
  const h = harness({
    launch: async () => {
      await shut;
    },
  });
  await leftover(h.memory.store, "P1");
  await h.engine.arm();
  h.at(minutes(2));

  // The leftover start is still held behind its gate.
  expect(await h.engine.push("github", { page: "P2" })).toEqual(["pages"]);
  open();
  await h.engine.drain();
  expect(h.memory.state("pages", "P2")?.state).toBe("started");
});

test("an occurrence that could not be recorded is polled again, not skipped past", async () => {
  const memory = memoryStore();
  let failing = true;
  const flaky: TriggerStore = {
    ...memory.store,
    record: async (row) => {
      if (failing && row.occurrence === "P9") throw new Error("connection reset");
      return memory.store.record(row);
    },
  };
  const h = harness({ store: flaky });
  await h.engine.arm();
  h.at(minutes(10));
  h.queued.push(event("P8", minutes(2)), event("P9", minutes(4)));
  await h.engine.poll("pages");
  failing = false;
  h.at(minutes(20));
  h.queued.push(event("P9", minutes(4)));
  await h.engine.poll("pages");

  expect(h.polls[1]?.getTime()).toBeLessThan(minutes(4).getTime());
  expect(memory.state("pages", "P9")?.state).toBe("started");
});

test("an event whose occurrence cannot be derived is passed over, not held", async () => {
  const h = harness();
  await h.engine.arm();
  h.at(minutes(10));
  h.queued.push({ inputs: {}, at: minutes(2) }, event("P1", minutes(3)));
  await h.engine.poll("pages");
  h.at(minutes(20));
  await h.engine.poll("pages");

  expect(h.polls[1]).toEqual(minutes(10));
  expect(h.memory.state("pages", "P1")?.state).toBe("started");
  expect(h.lines).toContain("[trigger] pages passed over an event: Error: no page id in the event");
});

test("a window held for an unrecorded occurrence never reaches back past the lookback", async () => {
  const memory = memoryStore();
  const failing: TriggerStore = {
    ...memory.store,
    record: async () => {
      throw new Error("connection reset");
    },
  };
  const h = harness({ store: failing });
  await memory.store.enable("pages", minutes(-600));
  await h.engine.arm();
  h.queued.push(event("P1", minutes(-100)));
  await h.engine.poll("pages");
  await h.engine.poll("pages");
  expect(h.polls).toEqual([minutes(-600), minutes(-60)]);
});

test("a started run the World no longer holds frees its slot", async () => {
  const h = harness({ trigger: { ...pagesTrigger, maxActive: 1 } });
  await h.engine.arm();
  await h.memory.store.record({
    trigger: "pages",
    occurrence: "P0",
    state: "pending",
    inputs: { page: "P0" },
    occurredAt: T0,
  });
  await h.memory.store.started("pages", "P0", "wrun_purged");
  h.at(minutes(2));
  await h.engine.push("github", { page: "P1" });
  await h.engine.drain();
  expect(h.starts.map((start) => start.triggerId)).toEqual([eventTriggerId("pages", "P1")]);
});

test("one trigger's failing start holds up no other trigger", async () => {
  const h = harness({
    triggers: { alpha: pagesTrigger, beta: pagesTrigger },
    launch: async (_inputs, triggerId) => {
      if (triggerId.startsWith("trigger:alpha:")) throw new Error("world unreachable");
    },
  });
  await h.engine.arm();
  h.at(minutes(2));
  expect(await h.engine.push("github", { page: "P1" })).toEqual(["alpha", "beta"]);
  await h.engine.drain();
  expect(h.memory.state("alpha", "P1")?.state).toBe("pending");
  expect(h.memory.state("beta", "P1")?.state).toBe("started");
});

test("stopping waits for the start in flight and starts nothing after", async () => {
  const { shut, open } = gate();
  let starts = 0;
  const h = harness({
    launch: async () => {
      starts += 1;
      await shut;
    },
  });
  await h.engine.arm();
  h.at(minutes(2));
  await h.engine.push("github", { page: "P1" });
  await h.engine.push("github", { page: "P2" });
  await vi.waitFor(() => expect(starts).toBe(1));

  let settled = false;
  const stopped = h.engine.stop().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  open();
  await stopped;
  expect(starts).toBe(1);
  expect(h.memory.state("pages", "P2")?.state).toBe("pending");
});

test("an unknown source kind is refused at boot with its repair, and the rest still run", () => {
  const lines: string[] = [];
  const { source } = fakeSource();
  const engine = createTriggerEngine(
    factory({
      broken: { ...pagesTrigger, source: { kind: "nope.things", params: {} } },
      pages: pagesTrigger,
    }),
    {
      sources: { "fake.pages": source },
      log: (line) => lines.push(line),
      store: memoryStore().store,
    },
  );
  expect(engine.triggers).toEqual([{ name: "pages", provider: "github" }]);
  expect(lines).toEqual([
    '[trigger] broken not started: source "nope.things" is not a source this jigs version provides',
    "  → set triggers.broken.source in jigs.config.ts to one of: fake.pages",
  ]);
});

async function check(name: string, trigger: EventTrigger, sources?: SourceRegistry) {
  const found = triggerChecks(
    factory({ [name]: trigger }),
    sources ?? { "fake.pages": fakeSource().source },
  ).find((c) => c.id === `trigger.${name}`);
  if (found === undefined) throw new Error(`no trigger.${name} check`);
  return { label: found.label, ...(await found.run()) };
}

test("a trigger whose workflow, source and inputs hold passes its check", async () => {
  expect(await check("pages", pagesTrigger)).toEqual({ label: "trigger pages", ok: true });
});

test("an unknown source kind fails its check; with no sources shipped, the repair says so", async () => {
  const result = await check("pages", pagesTrigger, {});
  expect(result.ok === false && result.repair).toBe(
    'remove the "pages" trigger from jigs.config.ts\nthis jigs version provides no sources; upgrade jigs for the one it names',
  );
});

test("a workflow that does not accept the source's inputs fails its check", async () => {
  const result = await check("pages", { ...pagesTrigger, inputs: {} });
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toContain("team");
  expect(result.ok === false && result.repair).toBe(
    "make the respond workflow's inputs accept page from the fake.pages source, and fix triggers.pages.inputs in jigs.config.ts to supply the rest",
  );
});

test("an unknown workflow, a colon, bad params and a bad cap each fail the check", async () => {
  const reasons = await Promise.all(
    [
      ["pages", { ...pagesTrigger, workflow: "respnd" }],
      ["pages:x", pagesTrigger],
      ["pages", { ...pagesTrigger, source: { kind: "fake.pages", params: {} } }],
      ["pages", { ...pagesTrigger, maxActive: 0 }],
      ["pages", { ...pagesTrigger, lookbackMinutes: -1 }],
    ].map(async ([name, trigger]) => {
      const result = await check(name as string, trigger as EventTrigger);
      return result.ok === false ? result.reason : "ok";
    }),
  );
  expect(reasons).toEqual([
    'workflow "respnd" is not one of this factory\'s workflows',
    'trigger name "pages:x" contains ":"',
    "source params do not satisfy fake.pages: service Invalid input: expected string, received undefined",
    "maxActive 0 is not a whole number of at least 1",
    "lookbackMinutes -1 is not a positive number of minutes",
  ]);
});

const row = (over: Partial<RunRow> = {}): RunRow => ({
  runId: "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  workflow: "respond",
  status: "running",
  trigger: "trigger:pages",
  ticket: null,
  createdAt: T0.toISOString(),
  lastActivityAt: T0.toISOString(),
  steps: 0,
  lastStep: null,
  suspensions: [],
  workflowName: "workflow//./workflows/respond//respond",
  claim: null,
  resources: [],
  ...over,
});

test("the listing counts pending, active and failed, and carries each failure's repair", async () => {
  const memory = memoryStore();
  await memory.store.record({
    trigger: "pages",
    occurrence: "P1",
    state: "pending",
    inputs: {},
    occurredAt: T0,
  });
  await memory.store.record({
    trigger: "pages",
    occurrence: "P2",
    state: "pending",
    inputs: {},
    occurredAt: T0,
  });
  await memory.store.failed("pages", "P2", preflightFailure);
  for (const [occurrence, runId] of [
    ["P3", "wrun_live"],
    ["P4", "wrun_done"],
  ] as const) {
    await memory.store.record({
      trigger: "pages",
      occurrence,
      state: "pending",
      inputs: {},
      occurredAt: T0,
    });
    await memory.store.started("pages", occurrence, runId);
  }
  // An attempted row holds a slot, as the engine's cap counts it.
  await memory.store.record({
    trigger: "pages",
    occurrence: "P5",
    state: "pending",
    inputs: {},
    occurredAt: T0,
  });
  await memory.store.attempt("pages", "P5", "wrun_attempted", T0);
  // Counted from this trigger's own started rows: a live run of the same
  // label that it did not start is not its business.
  const views = await listTriggers(factory({ pages: pagesTrigger }), {
    store: memory.store,
    listRuns: async () => [
      row({ runId: "wrun_live" }),
      row({ runId: "wrun_done", status: "completed" }),
      row({ runId: "wrun_foreign" }),
    ],
  });
  expect(views).toEqual([
    {
      name: "pages",
      workflow: "respond",
      source: "fake.pages",
      lastEvent: null,
      pending: 1,
      active: 2,
      failed: 1,
      failures: [
        {
          occurrence: "P2",
          at: T0.toISOString(),
          checks: preflightFailure.checks,
        },
      ],
    },
  ]);
});

test("a factory declaring no triggers lists none and starts nothing", async () => {
  expect(await listTriggers({ workflows: {} })).toEqual([]);
  expect(triggerChecks({ workflows: {} })).toEqual([]);
  expect(startTriggers({ workflows: {} }).triggers).toEqual([]);
});

test("a failed arm at boot is retried by the polls, and the timers still run", async () => {
  const { source, polls } = fakeSource();
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const memory = memoryStore();
  let enables = 0;
  const lines: string[] = [];
  startTriggers(factory({ pages: pagesTrigger }), {
    store: {
      ...memory.store,
      enable: async (trigger, now) => {
        enables += 1;
        if (enables <= 2) throw new Error("registry unreachable");
        return memory.store.enable(trigger, now);
      },
    },
    sources: { "fake.pages": source },
    now: () => T0,
    log: (line) => lines.push(line),
    runStatuses: async () => new Map(),
    ready: async () => {},
    intervalSeconds: async () => ({ github: 300, linear: 300 }),
    random: () => 0,
    setTimer: (fire, ms) => {
      timers.push({ fire, ms });
      return () => {};
    },
  });
  await vi.waitFor(() => expect(timers.map((timer) => timer.ms).sort()).toEqual([30_000, 300_000]));
  expect(polls).toEqual([]);
  timers.find((timer) => timer.ms === 300_000)?.fire();
  await vi.waitFor(() => expect(polls).toEqual([T0]));
  expect(lines[0]).toContain("could not enable triggers, retrying on each poll");
});

test("the service arms, polls each trigger at once and again on its provider's interval", async () => {
  const { source, polls } = fakeSource();
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const memory = memoryStore();
  startTriggers(factory({ pages: pagesTrigger }), {
    store: memory.store,
    sources: { "fake.pages": source },
    now: () => T0,
    log: () => {},
    runStatuses: async () => new Map(),
    ready: async () => {},
    intervalSeconds: async () => ({ github: 300, linear: 300 }),
    random: () => 0,
    setTimer: (fire, ms) => {
      timers.push({ fire, ms });
      return () => {};
    },
  });
  await vi.waitFor(() => expect(timers.map((timer) => timer.ms).sort()).toEqual([30_000, 300_000]));
  expect(polls).toEqual([T0]);
  expect(memory.marks.get("pages")).toEqual({ enabledAt: T0, polledThrough: T0 });
});
