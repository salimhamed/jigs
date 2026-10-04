import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import type { CheckReport } from "../../checks/index.ts";
import { coerceInputs, splitInputs } from "../../cli/commands/run.ts";
import { hintLines } from "../../cli/output.ts";
import * as slackApi from "../../providers/slack.ts";
import type { EventTrigger, Factory } from "../../workflow/factory.ts";
import type { PreparedRun } from "../launch.ts";
import { eventTriggerId, runIdTime } from "../runs.ts";
import { slackSources } from "../slack-sources.ts";
import { memoryTriggerStore } from "../test-fixtures.ts";
import { createTriggerEngine, type TriggerDeps } from "./engine.ts";
import { startTriggers } from "./runner.ts";
import type { Source, SourceOccurrence, SourceRegistry } from "./sources.ts";
import type { TriggerStore } from "./store.ts";
import { listTriggers, triggerChecks } from "./view.ts";

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
// pushed events are `{ page }` objects. Its cursor is when it last polled, and
// `polls` records where each poll began reading.
function fakeSource(now: () => Date = () => T0) {
  const queued: SourceOccurrence[] = [];
  const polls: Date[] = [];
  const source: Source<{ service: string }, string> = {
    provider: "github",
    params: z.object({ service: z.string() }),
    cursor: z.iso.datetime(),
    sampleInputs: { page: "P0" },
    occurrence: (inputs) => {
      if (typeof inputs.page !== "string") throw new Error("no page id in the event");
      return inputs.page;
    },
    poll: async (_params, cursor, floor) => {
      const through = now();
      polls.push(
        new Date(Math.max(cursor === undefined ? 0 : Date.parse(cursor), floor.getTime())),
      );
      return { occurrences: queued.splice(0), cursor: through.toISOString() };
    },
    fromPush: async (_params, event) => {
      const page = (event as { page?: unknown }).page;
      return typeof page === "string" ? { inputs: { page }, at: minutes(1) } : null;
    },
    describe: (inputs) => `page ${String(inputs.page)}`,
  };
  return { source, queued, polls };
}

const memoryStore = (now: () => Date = () => T0) => memoryTriggerStore(now, T0);

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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let runCounter = 0;
// A run ID as the SDK mints them, from this clock: the lookup stops on its time.
function mintAt(at: Date): string {
  let time = "";
  for (let ms = at.getTime(), i = 0; i < 10; i += 1, ms = Math.floor(ms / 32))
    time = CROCKFORD[ms % 32] + time;
  runCounter += 1;
  return `wrun_${time}${String(runCounter).padStart(16, "0")}`;
}

// The World as the engine reads it: runs with a status and plaintext
// attributes, and whether the World holds them yet. No inputs at all, as if
// the World encrypted every one.
interface FakeRun {
  runId: string;
  status: string;
  attributes: Record<string, string>;
  inWorld: boolean;
}

/**
 * How one start ends. `ok` creates and queues the run; `queue-rejected`
 * creates it pending and throws; `accepted-uncreated` throws with the queue
 * holding a delivery that creates it (`deliver()`); `nothing` throws before
 * any write; `resilient` returns an ID the World holds only once delivered;
 * `hang` never settles, as when the process dies mid-start.
 */
type StartMode = "ok" | "queue-rejected" | "accepted-uncreated" | "nothing" | "resilient" | "hang";

const launchedTwice: string[] = [];
afterEach(() => {
  expect(launchedTwice).toEqual([]);
});

const ATTRIBUTE = "jigs.occurrence";
const attributeFor = (occurrence: string, trigger = "pages") =>
  createHash("sha256").update(`factory-a\ntrigger:${trigger}:${occurrence}`).digest("hex");

function harness(
  options: {
    trigger?: EventTrigger;
    triggers?: Record<string, EventTrigger>;
    runs?: FakeRun[];
    prepare?: TriggerDeps["prepareRun"];
    /** Runs before the World call; throwing fails the start with nothing written. */
    launch?: (inputs: unknown, triggerId: string) => Promise<void>;
    modes?: StartMode[];
    store?: TriggerStore;
    memory?: ReturnType<typeof memoryStore>;
    /** Sources beside the fake one. */
    sources?: SourceRegistry;
  } = {},
) {
  let clock = T0;
  const { source, queued, polls } = fakeSource(() => clock);
  const memory = options.memory ?? memoryStore(() => clock);
  const lines: string[] = [];
  const starts: Array<{ inputs: unknown; triggerId: string }> = [];
  const runs = options.runs ?? [];
  const modes = options.modes ?? [];
  const cancelled: string[] = [];
  const cancelFailures = { before: 0, after: 0 };
  const sources: SourceRegistry = { "fake.pages": source, ...options.sources };
  const held = () => runs.filter((run) => run.inWorld);
  const deps = {
    store: options.store ?? memory.store,
    sources,
    now: () => clock,
    log: (line: string) => lines.push(line),
    factorySlug: () => "factory-a",
    runStatuses: async (ids: readonly string[]) =>
      new Map(
        held()
          .filter((run) => ids.includes(run.runId))
          .map((run) => [run.runId, run.status]),
      ),
    findRunsByAttribute: async (query: { key: string; value: string; since: Date }) =>
      held()
        .filter((run) => run.attributes[query.key] === query.value)
        .filter((run) => (runIdTime(run.runId) as number) >= query.since.getTime())
        .sort((a, b) => (a.runId < b.runId ? 1 : -1))
        .map(({ runId, status }) => ({ runId, status })),
    liveRunsByAttribute: async (_workflow: string | undefined, key: string) => {
      const grouped = new Map<string, Array<{ runId: string; status: string }>>();
      for (const run of [...held()].sort((a, b) => (a.runId < b.runId ? 1 : -1))) {
        const value = run.attributes[key];
        if (value === undefined || (run.status !== "pending" && run.status !== "running")) continue;
        grouped.set(value, [
          ...(grouped.get(value) ?? []),
          { runId: run.runId, status: run.status },
        ]);
      }
      return grouped;
    },
    cancelRun: async (runId: string) => {
      if (cancelFailures.before > 0) {
        cancelFailures.before -= 1;
        throw new Error("cancel failed");
      }
      cancelled.push(runId);
      const run = runs.find((candidate) => candidate.runId === runId);
      if (run) run.status = "cancelled";
      if (cancelFailures.after > 0) {
        cancelFailures.after -= 1;
        throw new Error("cancel answer lost");
      }
    },
    prepareRun:
      options.prepare ??
      (async (_factory: Factory, _workflow: string, inputs: unknown): Promise<PreparedRun> => ({
        kind: "ready",
        launch: async (triggerId, attributes = {}) => {
          // Every scenario here: a row's one start, never a second.
          if (starts.some((start) => start.triggerId === triggerId)) launchedTwice.push(triggerId);
          starts.push({ inputs, triggerId });
          await options.launch?.(inputs, triggerId);
          const mode = modes.shift() ?? "ok";
          if (mode === "nothing") throw new Error("world unreachable");
          if (mode === "hang") return new Promise<string>(() => {});
          const runId = mintAt(clock);
          const run = { runId, status: "running", attributes, inWorld: true };
          if (mode === "queue-rejected") {
            runs.push({ ...run, status: "pending" });
            throw new Error("queue unavailable");
          }
          if (mode === "accepted-uncreated") {
            runs.push({ ...run, inWorld: false });
            throw new Error("Connection terminated unexpectedly");
          }
          runs.push({ ...run, inWorld: mode !== "resilient" });
          return runId;
        },
      })),
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
    modes,
    cancelled,
    cancelFailures,
    sources,
    /** The queued deliveries create their runs. */
    deliver: () => {
      for (const run of runs) run.inWorld = true;
    },
    /** A second engine over the same rows and World, as after a restart. */
    restart: () =>
      createTriggerEngine(
        factory(options.triggers ?? { pages: options.trigger ?? pagesTrigger }),
        deps,
      ),
    at: (next: Date) => {
      clock = next;
    },
  };
}

const pendingRow = (store: TriggerStore, occurrence: string, occurredAt: Date, trigger = "pages") =>
  store.record({
    trigger,
    occurrence,
    state: "pending",
    inputs: { page: occurrence },
    attribute: attributeFor(occurrence, trigger),
    occurredAt,
  });

const activeOf = async (h: ReturnType<typeof harness>) =>
  (
    await listTriggers(factory({ pages: pagesTrigger }), {
      store: h.memory.store,
      liveRunsByAttribute: h.deps.liveRunsByAttribute,
      runStatuses: h.deps.runStatuses,
      now: h.deps.now,
    })
  )[0]?.active;

const occurrenceAt = (page: string, at: Date): SourceOccurrence => ({ inputs: { page }, at });

test("an occurrence seen twice, polled then pushed, starts one run", async () => {
  const h = harness();
  await h.engine.arm();
  h.at(minutes(2));
  h.queued.push(occurrenceAt("P1", minutes(1)));
  await h.engine.poll("pages");
  expect(await h.engine.push("github", { page: "P1" })).toEqual([]);
  h.queued.push(occurrenceAt("P1", minutes(1)));
  await h.engine.poll("pages");
  await h.engine.drain();

  expect(h.starts).toEqual([
    { inputs: { team: "infra", page: "P1" }, triggerId: eventTriggerId("pages", "P1") },
  ]);
  expect(h.runs[0]?.attributes).toEqual({ [ATTRIBUTE]: attributeFor("P1") });
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
  await pendingRow(h.memory.store, "P2", minutes(-5));

  await h.engine.arm();
  await h.engine.drain();

  expect(h.starts.map((start) => start.triggerId)).toEqual([eventTriggerId("pages", "P2")]);
  expect(h.memory.state("pages", "P2")?.state).toBe("started");
});

const leftover = async (store: TriggerStore, occurrence: string) => {
  await store.enable("pages", minutes(-60));
  await pendingRow(store, occurrence, minutes(-5));
};

test("runs this trigger did not start do not count against its cap", async () => {
  const runs: FakeRun[] = [1, 2, 3].map(() => ({
    runId: mintAt(T0),
    status: "running",
    attributes: {},
    inWorld: true,
  }));
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
    occurrenceAt("P4", minutes(4)),
    occurrenceAt("P1", minutes(1)),
    occurrenceAt("P3", minutes(3)),
    occurrenceAt("P2", minutes(2)),
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

test("the cap defaults to twenty", async () => {
  const h = harness();
  await h.engine.arm();
  h.at(minutes(30));
  h.queued.push(...Array.from({ length: 21 }, (_, i) => occurrenceAt(`P${i + 1}`, minutes(i + 1))));
  await h.engine.poll("pages");
  expect(h.starts).toHaveLength(20);
});

test("a new trigger starts from now: nothing before its first enable is recorded", async () => {
  const h = harness();
  await h.engine.arm();
  h.queued.push(occurrenceAt("OLD", minutes(-1)), occurrenceAt("NEW", minutes(0)));
  await h.engine.poll("pages");

  expect(h.polls).toEqual([T0]);
  expect(h.memory.state("pages", "OLD")).toBeUndefined();
  expect(h.memory.state("pages", "NEW")?.state).toBe("started");
});

test("an occurrence stamped in the second its trigger was enabled is admitted, at its own time", async () => {
  const h = harness();
  const enabled = new Date(T0.getTime() + 700);
  h.at(enabled);
  await h.engine.arm();
  h.queued.push(occurrenceAt("BEFORE", new Date(T0.getTime() - 1)), occurrenceAt("SAME", T0));
  await h.engine.poll("pages");

  expect(h.memory.marks.get("pages")?.enabledAt).toEqual(enabled);
  expect(h.memory.state("pages", "BEFORE")).toBeUndefined();
  expect(h.memory.state("pages", "SAME")).toMatchObject({ state: "started", occurredAt: T0 });
});

test("after downtime, the source reads from the lookback, past it is skipped and recent ones start", async () => {
  const h = harness({ trigger: { ...pagesTrigger, lookbackMinutes: 30 } });
  await h.memory.store.enable("pages", minutes(-600));
  await h.memory.store.advance("pages", minutes(-500).toISOString());
  h.at(minutes(0));
  await h.engine.arm();
  // A source may hand back occurrences from behind its floor, as PagerDuty's overlap does.
  h.queued.push(occurrenceAt("STALE", minutes(-45)), occurrenceAt("FRESH", minutes(-10)));
  await h.engine.poll("pages");

  expect(h.polls).toEqual([minutes(-30)]);
  expect(h.memory.state("pages", "STALE")?.state).toBe("skipped");
  expect(h.memory.state("pages", "FRESH")?.state).toBe("started");
  expect(h.starts).toHaveLength(1);
  expect(h.lines).toContain("[trigger] pages STALE skipped: older than its 30-minute lookback");
});

test("the lookback defaults to an hour", async () => {
  const h = harness();
  await h.memory.store.enable("pages", minutes(-600));
  await h.engine.arm();
  h.queued.push(occurrenceAt("A", minutes(-61)), occurrenceAt("B", minutes(-59)));
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

test("a stored cursor the source does not recognise reads from the floor", async () => {
  const h = harness();
  await h.memory.store.enable("pages", T0);
  await h.memory.store.advance("pages", { channel: "not this source's" });
  await h.engine.arm();
  h.at(minutes(5));
  await h.engine.poll("pages");
  expect(h.polls).toEqual([T0]);
  expect(h.memory.marks.get("pages")?.cursor).toBe(minutes(5).toISOString());
  expect(h.lines).toContain(
    "[trigger] pages reads from its lookback: its stored cursor is not one it wrote",
  );
});

test("a failed poll leaves the cursor where it was", async () => {
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
  expect(h.lines).toContain("[trigger] pages P1 could not start: Error: Linear unreachable");
});

// Recovery. A row is launched once. An attempted row not yet started is
// uncertain: its run is adopted if found, and otherwise, after the settle
// period, the row is failed for the operator. Nothing launches it again; the
// afterEach above checks that across every test.

const attempted = async (h: ReturnType<typeof harness>, occurrence: string, at: Date) => {
  await pendingRow(h.memory.store, occurrence, minutes(-5));
  await h.memory.store.attempt("pages", occurrence, at);
};
const runFor = (occurrence: string, at: Date, status = "running"): FakeRun => ({
  runId: mintAt(at),
  status,
  attributes: { [ATTRIBUTE]: attributeFor(occurrence) },
  inWorld: true,
});

test("after a crash, an attempted row's run found running is adopted", async () => {
  const run = runFor("P1", T0);
  const h = harness({ runs: [run] });
  await attempted(h, "P1", T0);
  await h.engine.arm();
  await h.engine.drain();
  expect(h.starts).toEqual([]);
  expect(h.memory.state("pages", "P1")).toMatchObject({ state: "started", runId: run.runId });
});

test("after a crash, a pending run is adopted: the World's restart recovery queues it", async () => {
  const run = runFor("P1", T0, "pending");
  const h = harness({ runs: [run] });
  await attempted(h, "P1", T0);
  h.at(minutes(30));
  const engine = h.restart();
  await engine.arm();
  await engine.drain();
  expect(h.memory.state("pages", "P1")?.state).toBe("pending");
  h.at(minutes(36));
  await engine.drain();
  expect(h.cancelled).toEqual([]);
  expect(h.memory.state("pages", "P1")).toMatchObject({ state: "started", runId: run.runId });
});

test("a thrown start with no run found is failed with a repair after the settle period, not before", async () => {
  const h = harness({ modes: ["nothing"], trigger: { ...pagesTrigger, maxActive: 1 } });
  await h.engine.arm();
  h.at(minutes(2));
  await pendingRow(h.memory.store, "P1", minutes(1));
  await h.engine.drain();
  await pendingRow(h.memory.store, "LATE", minutes(-30));
  h.at(minutes(6));
  await h.engine.drain();
  // Still uncertain, and still holding its slot.
  expect(h.memory.state("pages", "P1")?.state).toBe("pending");
  expect(h.memory.state("pages", "LATE")?.attemptedAt).toBeNull();
  h.at(minutes(8));
  await h.engine.drain();
  const row = h.memory.state("pages", "P1");
  expect(row?.state).toBe("failed");
  expect(row?.report?.checks[0]).toMatchObject({
    reason: "its start could not be confirmed: no run of respond appeared",
    repair: checkFirst(minutes(2), `--input 'team="infra"' --input 'page="P1"'`),
  });
  expect(h.starts).toHaveLength(2);
  expect(h.starts[1]?.triggerId).toBe(eventTriggerId("pages", "LATE"));
});

test("a thrown start whose run is pending after the settle period is cancelled and failed", async () => {
  const h = harness({ modes: ["queue-rejected"] });
  await h.engine.arm();
  h.at(minutes(2));
  await pendingRow(h.memory.store, "P1", minutes(1));
  await h.engine.drain();
  const orphan = h.runs[0] as FakeRun;
  h.at(minutes(6));
  await h.engine.drain();
  expect(h.cancelled).toEqual([]);
  h.at(minutes(8));
  await h.engine.drain();
  expect(h.cancelled).toEqual([orphan.runId]);
  const row = h.memory.state("pages", "P1");
  expect(row?.state).toBe("failed");
  // The cancel can race a run that had just begun, so it too checks first.
  expect(row?.report?.checks[0]).toMatchObject({
    reason: `its run ${orphan.runId} was created but never queued, and was cancelled`,
    repair: checkFirst(minutes(2), `--input 'team="infra"' --input 'page="P1"'`),
  });
  expect(h.starts).toHaveLength(1);
});

test("a thrown start whose queue accepted is adopted when its run appears, even after the row failed", async () => {
  const h = harness({ modes: ["accepted-uncreated", "accepted-uncreated"] });
  await h.engine.arm();
  h.at(minutes(2));
  await pendingRow(h.memory.store, "P1", minutes(1));
  await pendingRow(h.memory.store, "P2", minutes(1));
  await h.engine.drain();
  // P1's delivery lands inside the settle period.
  const [first, second] = h.runs as FakeRun[];
  (first as FakeRun).inWorld = true;
  h.at(minutes(4));
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")).toMatchObject({ state: "started", runId: first?.runId });
  // P2's, days after its row failed.
  h.at(minutes(8));
  await h.engine.drain();
  expect(h.memory.state("pages", "P2")?.state).toBe("failed");
  h.at(minutes(9 * 24 * 60));
  (second as FakeRun).inWorld = true;
  await h.engine.drain();
  expect(h.memory.state("pages", "P2")).toMatchObject({
    state: "started",
    runId: second?.runId,
    report: null,
  });
  expect(h.starts).toHaveLength(2);
});

test("a first arm whose markers fail still starts the settle clock, so an unconfirmed start fails", async () => {
  const h = harness({ modes: ["nothing"] });
  const enable = h.memory.store.enable;
  let fails = 1;
  h.memory.store.enable = async (trigger, now) => {
    if (fails-- > 0) throw new Error("db blip");
    return enable(trigger, now);
  };
  await expect(h.engine.arm()).rejects.toThrow("db blip");
  await pendingRow(h.memory.store, "P1", T0);
  // A later poll retries the markers; the drain starts P1, whose start throws.
  await h.engine.poll("pages");
  await h.engine.drain();
  expect(h.starts).toHaveLength(1);
  h.at(minutes(4));
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")?.state).toBe("pending");
  h.at(minutes(6));
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")?.state).toBe("failed");
});

test("a cancel that fails keeps the row attempted, and retries before failing it", async () => {
  const h = harness({ modes: ["queue-rejected"] });
  await h.engine.arm();
  await pendingRow(h.memory.store, "P1", T0);
  await h.engine.drain();
  const orphan = h.runs[0] as FakeRun;
  h.at(minutes(6));
  h.cancelFailures.before = 1;
  await h.engine.drain();
  // Not failed, and not adopted: the never-queued run is still pending.
  expect(h.memory.state("pages", "P1")).toMatchObject({ state: "pending", runId: null });
  await h.engine.drain();
  expect(orphan.status).toBe("cancelled");
  const row = h.memory.state("pages", "P1");
  expect(row?.state).toBe("failed");
  expect(row?.report?.checks[0]).toMatchObject({
    reason: `its run ${orphan.runId} was created but never queued, and was cancelled`,
  });
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")?.state).toBe("failed");
});

test("a run someone else cancelled is adopted as the occurrence's run", async () => {
  const run = runFor("P1", T0, "cancelled");
  const h = harness({ runs: [run] });
  await attempted(h, "P1", T0);
  await h.engine.arm();
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")).toMatchObject({ state: "started", runId: run.runId });
});

test("a started write that fails is retried with the run ID held, never a second start", async () => {
  const h = harness();
  await h.engine.arm();
  h.memory.failures.started = 3;
  await pendingRow(h.memory.store, "P1", T0);
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")?.state).toBe("pending");
  await h.engine.drain();
  expect(h.starts).toHaveLength(1);
  expect(h.memory.state("pages", "P1")).toMatchObject({
    state: "started",
    runId: h.runs[0]?.runId,
  });
});

test("a resilient start's run counts, on the cap and in status, until the World holds it or an hour passes", async () => {
  const h = harness({ modes: ["resilient"], trigger: { ...pagesTrigger, maxActive: 1 } });
  await h.engine.arm();
  await pendingRow(h.memory.store, "P1", T0);
  await h.engine.drain();
  await pendingRow(h.memory.store, "P2", minutes(1));
  h.at(minutes(2));
  await h.engine.drain();
  expect(h.starts).toHaveLength(1);
  expect(await activeOf(h)).toBe(1);
  h.at(minutes(61));
  await h.engine.drain();
  expect(h.starts).toHaveLength(2);
});

test("a late older occurrence waits while a newer one's run is recovered first", async () => {
  const live = runFor("NEWER", minutes(-4));
  const h = harness({ trigger: { ...pagesTrigger, maxActive: 1 }, runs: [live] });
  await h.memory.store.enable("pages", minutes(-60));
  await attempted(h, "NEWER", minutes(-4));
  await pendingRow(h.memory.store, "OLDER", minutes(-10));
  await h.engine.arm();
  await h.engine.drain();
  expect(h.starts).toEqual([]);
  expect(h.memory.state("pages", "NEWER")).toMatchObject({ state: "started", runId: live.runId });
  expect(h.memory.state("pages", "OLDER")?.state).toBe("pending");
});

test("S3: the settle period runs from when the engine is armed, after the service's gates", async () => {
  const h = harness({ modes: ["accepted-uncreated"] });
  await h.engine.arm();
  h.at(minutes(2));
  await pendingRow(h.memory.store, "P1", minutes(1));
  await h.engine.drain();
  // A new process is built, then its readiness gates take ten minutes.
  h.at(minutes(3));
  const engine = h.restart();
  h.at(minutes(13));
  await engine.arm();
  await engine.drain();
  expect(h.memory.state("pages", "P1")?.state).toBe("pending");
  h.deliver();
  await engine.drain();
  expect(h.memory.state("pages", "P1")).toMatchObject({
    state: "started",
    runId: h.runs[0]?.runId,
  });
});

const checkFirst = (at: Date, inputs: string) =>
  `check \`pnpm exec jigs status\` for a run of respond started around ${at.toISOString()}\nif there is none, start it:\n\`pnpm exec jigs run respond ${inputs}\`\njigs adopts the run if one appears later`;

const unansweredReport = (reason: string): CheckReport => ({
  ok: false,
  checks: [
    {
      id: "github.identity",
      label: "GitHub identity",
      ok: false,
      reason,
      repair: "retry",
      unanswered: true,
    },
  ],
});

for (const [variant, reason] of [
  ["threw", "Error: getaddrinfo ENOTFOUND api.github.com"],
  ["timed out", "the check did not answer within 15000ms"],
] as const) {
  test(`S6: a preflight check that ${variant} leaves the row to retry, not failed`, async () => {
    let calls = 0;
    const h = harness();
    const prepare = h.deps.prepareRun;
    const engine = createTriggerEngine(factory({ pages: pagesTrigger }), {
      ...h.deps,
      prepareRun: async (...args) => {
        calls += 1;
        return calls === 1
          ? { kind: "preflight-failed", report: unansweredReport(reason) }
          : prepare(...args);
      },
    });
    await engine.arm();
    await pendingRow(h.memory.store, "P1", T0);
    await engine.drain();
    expect(h.memory.state("pages", "P1")).toMatchObject({ state: "pending", attemptedAt: null });
    expect(h.lines).toContain(
      `[trigger] pages P1 waits: preflight did not answer: GitHub identity: ${reason}`,
    );
    await engine.drain();
    expect(h.memory.state("pages", "P1")?.state).toBe("started");
  });
}

test("S6: a preflight check that refuses still marks the row failed", async () => {
  const h = harness({
    prepare: async () => ({ kind: "preflight-failed", report: preflightFailure }),
  });
  await h.engine.arm();
  await pendingRow(h.memory.store, "P1", T0);
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")?.state).toBe("failed");
});

test("N3: a row that throws every drain holds its slot and holds up nothing else", async () => {
  const h = harness({ trigger: { ...pagesTrigger, maxActive: 2 } });
  const engine = createTriggerEngine(factory({ pages: { ...pagesTrigger, maxActive: 2 } }), {
    ...h.deps,
    findRunsByAttribute: async (query) => {
      if (query.value === attributeFor("BAD")) throw new Error("lookup exploded");
      return h.deps.findRunsByAttribute(query);
    },
  });
  await attempted(h, "BAD", T0);
  await pendingRow(h.memory.store, "GOOD", minutes(1));
  await engine.arm();
  h.at(minutes(6));
  await engine.drain();
  await engine.drain();
  expect(h.lines).toContain("[trigger] pages BAD could not start: Error: lookup exploded");
  expect(h.memory.state("pages", "GOOD")?.state).toBe("started");
  expect(h.memory.state("pages", "BAD")?.state).toBe("pending");
  expect(await activeOf(h)).toBe(2);
});

test("F: two engines on one store racing for one pending row launch it once", async () => {
  const { shut, open } = gate();
  let prepared = 0;
  const h = harness();
  const prepare = h.deps.prepareRun;
  const racing = {
    ...h.deps,
    // Both read the row and pass preflight before either claims it.
    prepareRun: async (...args: Parameters<typeof prepare>) => {
      prepared += 1;
      await shut;
      return prepare(...args);
    },
  };
  const [one, two] = [racing, racing].map((deps) =>
    createTriggerEngine(factory({ pages: pagesTrigger }), deps),
  );
  await pendingRow(h.memory.store, "P1", T0);
  const drains = [one?.drain(), two?.drain()];
  await vi.waitFor(() => expect(prepared).toBe(2));
  open();
  await Promise.all(drains);
  expect(h.starts).toHaveLength(1);
  expect(h.lines).toContain("[trigger] pages P1: claimed by another start");
});

test("E: fixed inputs that clash with the source's are refused at boot with the doctor's repair", async () => {
  const lines: string[] = [];
  const { source } = fakeSource();
  const clashing = { ...pagesTrigger, inputs: { team: "infra", page: "P0" } };
  const engine = createTriggerEngine(factory({ pages: clashing }), {
    sources: { "fake.pages": source },
    log: (line) => lines.push(line),
    store: memoryStore().store,
  });
  expect(engine.triggers).toEqual([]);
  expect(lines).toEqual([
    "[trigger] pages not started: inputs page is also provided by the fake.pages source for each occurrence",
    "  → remove page from triggers.pages.inputs in jigs.config.ts\n    the source sets it for each occurrence",
  ]);
  const result = await check("pages", clashing);
  expect(result.ok === false && result.repair).toBe(
    "remove page from triggers.pages.inputs in jigs.config.ts\nthe source sets it for each occurrence",
  );
});

test("an unconfirmed start's command round-trips every input through the CLI's own parser", async () => {
  const inputs = {
    page: 'line one\nline `two` it\'s "$HOME" \\ back',
    uni: "héllo 🔥",
    number: "42",
    count: 3,
    flag: true,
    none: null,
    nested: { a: [1, "b'c"] },
  };
  const h = harness({ modes: ["nothing"] });
  await h.engine.arm();
  await h.memory.store.record({
    trigger: "pages",
    occurrence: "P1",
    state: "pending",
    inputs,
    attribute: attributeFor("P1"),
    occurredAt: T0,
  });
  await h.engine.drain();
  h.at(minutes(6));
  await h.engine.drain();
  const check = h.memory.state("pages", "P1")?.report?.checks[0];
  const repair = check?.ok === false ? check.repair : "";
  const line = repair.split("\n").find((text) => text.startsWith("`pnpm exec jigs run")) as string;
  // One command, one line, no backtick but the pair around it.
  expect(line.match(/`/g)).toHaveLength(2);
  const args = execFileSync(
    "bash",
    ["-c", `set -- ${line.slice("`pnpm exec jigs run respond".length, -1)}; printf '%s\\0' "$@"`],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((arg) => arg !== "");
  const pairs = args.filter((_arg, i) => args[i - 1] === "--input");
  const stringFields = z.toJSONSchema(
    z.looseObject({ team: z.string(), page: z.string(), uni: z.string(), number: z.string() }),
    { io: "input" },
  );
  expect(coerceInputs(splitInputs(pairs), stringFields)).toEqual({ team: "infra", ...inputs });
  // Rendered by status and doctor, the command stays on one line, printed plainly.
  const rendered = hintLines(repair);
  expect(rendered.filter((text) => text.includes("jigs run"))).toEqual([`  ${line.slice(1, -1)}`]);
  const doctor = await triggerChecks(
    factory({ pages: pagesTrigger }),
    { "fake.pages": fakeSource().source },
    { store: () => h.memory.store },
  )
    .find((c) => c.id === "trigger.pages.failed")
    ?.run();
  const detail = doctor?.ok === true ? (doctor.detail ?? "") : "";
  expect(detail.split("\n").filter((text) => text.includes("jigs run"))).toEqual([
    `  ${line.slice(1, -1)}`,
  ]);
});

test("a preflight that keeps not answering is failed with its report once the settle period has passed", async () => {
  const h = harness({
    prepare: async () => ({
      kind: "preflight-failed",
      report: unansweredReport("the check did not answer within 15000ms"),
    }),
  });
  await h.engine.arm();
  await pendingRow(h.memory.store, "P1", T0);
  h.at(new Date(minutes(5).getTime() - 1000));
  await h.engine.drain();
  expect(h.memory.state("pages", "P1")).toMatchObject({ state: "pending", attemptedAt: null });
  h.at(new Date(minutes(5).getTime() + 1000));
  await h.engine.drain();
  const row = h.memory.state("pages", "P1");
  expect(row?.state).toBe("failed");
  expect(row?.report?.checks).toEqual(
    unansweredReport("the check did not answer within 15000ms").checks,
  );
  const [view] = await listTriggers(factory({ pages: pagesTrigger }), {
    store: h.memory.store,
    liveRunsByAttribute: h.deps.liveRunsByAttribute,
    runStatuses: h.deps.runStatuses,
    now: h.deps.now,
  });
  expect(view?.failed).toBe(1);
  expect(h.starts).toEqual([]);
});

test("a failed uncertain start is listed with its repair in status and in doctor", async () => {
  const h = harness({ modes: ["nothing"] });
  await h.engine.arm();
  await pendingRow(h.memory.store, "P1", T0);
  await h.engine.drain();
  h.at(minutes(6));
  await h.engine.drain();
  const [view] = await listTriggers(factory({ pages: pagesTrigger }), {
    store: h.memory.store,
    liveRunsByAttribute: h.deps.liveRunsByAttribute,
    runStatuses: h.deps.runStatuses,
    now: h.deps.now,
  });
  const repair = h.memory.state("pages", "P1")?.report?.checks[0];
  expect(view?.failures).toEqual([{ occurrence: "P1", at: T0.toISOString(), checks: [repair] }]);
  const doctor = triggerChecks(
    factory({ pages: pagesTrigger }),
    { "fake.pages": fakeSource().source },
    { store: () => h.memory.store },
  ).find((c) => c.id === "trigger.pages.failed");
  const outcome = await doctor?.run();
  // A note: `jigs up` ends with doctor and must not refuse over it.
  expect(outcome?.ok).toBe(true);
  expect(outcome?.ok === true && outcome.detail?.split("\n")).toEqual([
    "1 failed, each waiting on the operator",
    "P1: its start could not be confirmed: no run of respond appeared",
    ...(repair?.ok === false
      ? repair.repair.split("\n").map((line) => `  ${line.replaceAll("`", "")}`)
      : []),
  ]);
});

test("a trigger with no failed occurrences has a clean doctor note", async () => {
  const doctor = triggerChecks(
    factory({ pages: pagesTrigger }),
    { "fake.pages": fakeSource().source },
    { store: () => memoryStore().store },
  ).find((c) => c.id === "trigger.pages.failed");
  expect(await doctor?.run()).toEqual({ ok: true });
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
  h.queued.push(occurrenceAt("P8", minutes(2)), occurrenceAt("P9", minutes(4)));
  await h.engine.poll("pages");
  failing = false;
  h.at(minutes(20));
  h.queued.push(occurrenceAt("P9", minutes(4)));
  await h.engine.poll("pages");

  expect(h.polls[1]?.getTime()).toBeLessThan(minutes(4).getTime());
  expect(memory.state("pages", "P9")?.state).toBe("started");
});

test("an occurrence the source cannot key is passed over, not held", async () => {
  const h = harness();
  await h.engine.arm();
  h.at(minutes(10));
  h.queued.push({ inputs: {}, at: minutes(2) }, occurrenceAt("P1", minutes(3)));
  await h.engine.poll("pages");
  h.at(minutes(20));
  await h.engine.poll("pages");

  expect(h.polls[1]).toEqual(minutes(10));
  expect(h.memory.state("pages", "P1")?.state).toBe("started");
  expect(h.lines).toContain(
    "[trigger] pages passed over an occurrence it could not key: Error: no page id in the event",
  );
});

test("a cursor held for an unrecorded occurrence never reaches back past the lookback", async () => {
  const memory = memoryStore();
  const failing: TriggerStore = {
    ...memory.store,
    record: async () => {
      throw new Error("connection reset");
    },
  };
  const h = harness({ store: failing });
  await memory.store.enable("pages", minutes(-600));
  await memory.store.advance("pages", minutes(-300).toISOString());
  await h.engine.arm();
  for (let poll = 0; poll < 2; poll += 1) {
    h.queued.push(occurrenceAt("P1", minutes(-30)));
    await h.engine.poll("pages");
  }
  expect(h.polls).toEqual([minutes(-60), minutes(-60)]);
  expect(memory.marks.get("pages")?.cursor).toBe(minutes(-300).toISOString());
  expect(h.lines).toContain("[trigger] pages: 1 not recorded, reading them again next poll");
});

test("a Slack channel that fails one poll holds back only itself, and its message starts on the next", async () => {
  const message = (at: Date) => ({
    type: "message",
    user: "U0HUMAN01",
    ts: (at.getTime() / 1000).toFixed(6),
  });
  const first = message(minutes(7));
  const second = message(minutes(5));
  const channels: Record<string, Array<ReturnType<typeof message>>> = {
    C0FIRST01: [first],
    C0SECOND1: [second],
  };
  const reads: Array<[string, string]> = [];
  let failing = true;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(slackApi, "slackBot").mockResolvedValue({
    userId: "U0BOT0001",
    botId: "B0BOT0001",
    user: "jigs",
    team: "T",
    scopes: [],
  });
  vi.spyOn(slackApi, "slackHistory").mockImplementation(async (channel, { oldest = "" }) => {
    reads.push([channel, oldest]);
    if (channel === "C0SECOND1" && failing) {
      failing = false;
      throw new slackApi.SlackApiError("conversations.history", "ratelimited");
    }
    return (channels[channel] ?? []).filter((message) => Number(message.ts) > Number(oldest));
  });
  try {
    let clock = () => T0;
    const h = harness({
      sources: slackSources(() => clock()),
      trigger: {
        workflow: "respond",
        source: { kind: "slack.messages", params: { channels: ["C0FIRST01", "C0SECOND1"] } },
        inputs: { page: "slack", team: "infra" },
      },
    });
    clock = h.deps.now;
    const started = () => h.starts.map((start) => (start.inputs as { channel: string }).channel);
    await h.engine.arm();
    h.at(minutes(10));
    await h.engine.poll("pages");
    expect(started()).toEqual(["C0FIRST01"]);

    h.at(minutes(20));
    await h.engine.poll("pages");
    expect(started()).toEqual(["C0FIRST01", "C0SECOND1"]);
    const ts = (at: Date) => (at.getTime() / 1000).toFixed(6);
    expect(reads.slice(2)).toEqual([
      ["C0FIRST01", ts(minutes(10))],
      ["C0SECOND1", ts(T0)],
    ]);
  } finally {
    vi.restoreAllMocks();
  }
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

test("an unknown source kind fails its check, and the repair names the known kinds", async () => {
  const result = await check("pages", pagesTrigger, { "fake.other": fakeSource().source });
  expect(result.ok === false && result.repair).toBe(
    "set triggers.pages.source in jigs.config.ts to one of: fake.other",
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

test("N4: a trigger naming an unknown workflow lists no runs rather than all of them", async () => {
  const memory = memoryStore();
  let listed = 0;
  const [view] = await listTriggers(factory({ pages: { ...pagesTrigger, workflow: "nope" } }), {
    store: memory.store,
    liveRunsByAttribute: async () => {
      listed += 1;
      return new Map();
    },
    runStatuses: async () => new Map(),
  });
  expect(listed).toBe(0);
  expect(view?.active).toBe(0);
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
    intervalSeconds: async () => ({ github: 300, linear: 300, slack: 300, pagerduty: 300 }),
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
    intervalSeconds: async () => ({ github: 300, linear: 300, slack: 300, pagerduty: 300 }),
    random: () => 0,
    setTimer: (fire, ms) => {
      timers.push({ fire, ms });
      return () => {};
    },
  });
  await vi.waitFor(() => expect(timers.map((timer) => timer.ms).sort()).toEqual([30_000, 300_000]));
  expect(polls).toEqual([T0]);
  expect(memory.marks.get("pages")).toEqual({ enabledAt: T0, cursor: T0.toISOString() });
});
