import type { ISql } from "postgres";
import { expect, test, vi } from "vitest";
import type { RunDetail } from "../run-actions";
import type { RunStarted } from "../run-events";
import type { RunRow } from "../runs";
import {
  createRunThreads,
  DEFAULT_POLL_MS,
  milestone,
  type RunThreadsDeps,
  rootMessage,
} from "./run-threads";
import type { SlackThreadRow } from "./threads-table";

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const OTHER = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";
const LOGS = `http://localhost:3001/run/${RUN}`;
const CHANNEL = "C0RUNS";

const started = (over: Partial<RunStarted> = {}): RunStarted => ({
  runId: RUN,
  pipeline: "ticket",
  triggerId: "manual-1",
  logs: LOGS,
  ...over,
});

const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  runId: RUN,
  status: "running",
  logs: LOGS,
  ...over,
});

const row = (over: Partial<RunRow> = {}): RunRow => ({
  runId: RUN,
  pipeline: "ticket",
  status: "running",
  trigger: "manual",
  createdAt: "2026-09-06T10:00:00.000Z",
  ...over,
});

const claim = {
  key: "ticket-claim",
  reason: "one active run per ticket",
  satisfiedBy: "linear:ticket:abc",
};

const parked = (...reasons: string[]) =>
  detail({
    status: "suspended",
    suspended: true,
    suspensions: [
      claim,
      ...reasons.map((reason, index) => ({
        key: `park-${index}`,
        reason,
        satisfiedBy: `github:pr:acme/api#${index}`,
      })),
    ],
  });

/** A fake postgres tag: it answers every SELECT with `rows` and records the
 *  inserts, which is all this module asks of a database. */
function fakeSql(rows: SlackThreadRow[] = []) {
  const inserted: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join(" ").includes("INSERT")) inserted.push(values);
    return Promise.resolve(rows);
  }) as unknown as ISql;
  return { sql, inserted };
}

function harness(
  over: Partial<RunThreadsDeps> = {},
  threadRows: SlackThreadRow[] = [],
) {
  const posted: Array<[string, string, string]> = [];
  const opened: Array<[string, string]> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const listings: number[] = [];
  const detailed: string[] = [];
  const ticks: Array<{ ms: number; tick: () => void; stopped: boolean }> = [];
  const state = { rows: [row()], detail: detail() };
  const { sql, inserted } = fakeSql(threadRows);
  const threads = createRunThreads({
    channel: CHANNEL,
    sql: () => sql,
    openThread: async (channel, text) => {
      opened.push([channel, text]);
      return "1757.0001";
    },
    postReply: async (channel, threadTs, text) => {
      posted.push([channel, threadTs, text]);
    },
    listRuns: async () => {
      listings.push(listings.length);
      return state.rows;
    },
    runDetail: async (runId) => {
      detailed.push(runId);
      return { ...state.detail, runId };
    },
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    ticker: (ms, tick) => {
      const entry = { ms, tick, stopped: false };
      ticks.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
    ...over,
  });
  /** One turn of the shared clock, awaited. */
  const tick = async () => {
    for (const entry of ticks) if (!entry.stopped) entry.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** What the listing and the detail read both say from here on. */
  const now = (status: string, over: Partial<RunDetail> = {}) => {
    state.rows = [row({ status })];
    state.detail = detail({ status, ...over });
  };
  return {
    threads,
    posted,
    opened,
    logs,
    errors,
    listings,
    detailed,
    ticks,
    inserted,
    state,
    tick,
    now,
  };
}

test("the root message names the pipeline, the trigger, the run and where to watch it", () => {
  expect(rootMessage(started())).toBe(
    `Run started: ticket (manual)\n${RUN}\n${LOGS}`,
  );
  expect(
    rootMessage(
      started({ triggerId: "schedule:nightly:2026-09-06T03:00:00Z" }),
    ),
  ).toBe(`Run started: ticket (schedule:nightly)\n${RUN}\n${LOGS}`);
});

test("a factory with no dashboard leaves the link line out rather than apologising", () => {
  expect(rootMessage(started({ logs: "dashboard: not configured" }))).toBe(
    `Run started: ticket (manual)\n${RUN}`,
  );
  expect(
    milestone(
      detail({ status: "stalled", logs: "dashboard: not configured" }),
      "active",
    ),
  ).toBe(`${RUN} is stalled — nothing is coming to move it`);
});

test("a run started anywhere else gets a thread of its own, mapped and watched", async () => {
  const h = harness();
  await h.threads.runStarted(started());
  expect(h.opened).toEqual([[CHANNEL, rootMessage(started())]]);
  expect(h.inserted).toEqual([[RUN, CHANNEL, "1757.0001"]]);
  expect(h.ticks).toHaveLength(1);
  h.threads.stop();
});

test("a run started from a thread is mapped to it without a second announcement", async () => {
  const h = harness();
  await h.threads.runStarted(
    started({
      origin: { kind: "slack-thread", channel: "C0DM", threadTs: "1757.0009" },
    }),
  );
  expect(h.opened).toEqual([]);
  expect(h.inserted).toEqual([[RUN, "C0DM", "1757.0009"]]);
  expect(h.ticks).toHaveLength(1);
  h.threads.stop();
});

test("a run already mapped is watched in the thread the table names, not the newer one", async () => {
  // ON CONFLICT DO NOTHING keeps the first mapping, so a second start must not
  // go on posting into a thread the table never accepted.
  const h = harness({}, [
    { runId: RUN, channel: "C0FIRST", threadTs: "1757.0000" },
  ]);
  await h.threads.runStarted(
    started({
      origin: { kind: "slack-thread", channel: "C0DM", threadTs: "1757.0009" },
    }),
  );
  h.now("suspended");
  h.state.detail = parked("awaiting pull request review");
  await h.tick();
  expect(h.posted).toEqual([
    ["C0FIRST", "1757.0000", `${RUN} is parked: awaiting pull request review`],
  ]);
  h.threads.stop();
});

test("a Slack failure at the start costs the run nothing but its thread", async () => {
  const h = harness({
    openThread: () => Promise.reject(new Error("channel_not_found")),
  });
  await expect(h.threads.runStarted(started())).resolves.toBeUndefined();
  expect(h.inserted).toEqual([]);
  expect(h.errors[0]).toContain("channel_not_found");
});

test("a root message Slack accepted without a ts leaves no half mapping", async () => {
  const h = harness({ openThread: async () => null });
  await h.threads.runStarted(started());
  expect(h.inserted).toEqual([]);
  expect(h.ticks).toEqual([]);
  expect(h.errors[0]).toContain("without a ts");
});

test("a run leaving the queue is not a milestone", async () => {
  const h = harness();
  h.now("pending");
  await h.threads.runStarted(started());
  await h.tick();
  h.now("running");
  await h.tick();
  expect(h.posted).toEqual([]);
  // Neither tick was worth a detail read: the listing already said nothing
  // moved.
  expect(h.detailed).toEqual([]);
  h.threads.stop();
});

test("a run parked on a gate is named, and coming back out of it is a resume", async () => {
  const h = harness();
  await h.threads.runStarted(started());

  await h.tick();
  expect(h.posted).toEqual([]);

  h.now("suspended");
  h.state.detail = parked("awaiting pull request review");
  await h.tick();
  expect(h.posted).toEqual([
    [CHANNEL, "1757.0001", `${RUN} is parked: awaiting pull request review`],
  ]);

  h.now("running");
  await h.tick();
  expect(h.posted.at(-1)?.[2]).toBe(`${RUN} resumed`);
  h.threads.stop();
});

test("nothing changing posts nothing and reads no detail, however often it is polled", async () => {
  const h = harness();
  await h.threads.runStarted(started());
  h.now("suspended");
  h.state.detail = parked("awaiting pull request review");
  await h.tick();
  await h.tick();
  await h.tick();
  expect(h.posted).toHaveLength(1);
  expect(h.detailed).toEqual([RUN]);
  expect(h.listings).toHaveLength(3);
  h.threads.stop();
});

test("one listing answers for every watched run, and only the movers cost a detail", async () => {
  const h = harness({}, [
    { runId: RUN, channel: CHANNEL, threadTs: "1757.0001" },
    { runId: OTHER, channel: CHANNEL, threadTs: "1757.0002" },
  ]);
  await h.threads.rehydrate([RUN, OTHER]);
  expect(h.ticks).toHaveLength(1);

  // The priming read: both runs move off "unknown", both are read once.
  h.state.rows = [row(), row({ runId: OTHER })];
  await h.tick();
  expect(h.listings).toHaveLength(1);
  expect(h.detailed).toEqual([RUN, OTHER]);

  h.state.rows = [row(), row({ runId: OTHER, status: "completed" })];
  h.state.detail = detail({ status: "completed" });
  await h.tick();
  expect(h.listings).toHaveLength(2);
  expect(h.detailed).toEqual([RUN, OTHER, OTHER]);
  h.threads.stop();
});

test("the terminal milestone is the last thing the watch does", async () => {
  const h = harness();
  await h.threads.runStarted(started());
  h.now("completed");
  await h.tick();
  expect(h.posted).toEqual([[CHANNEL, "1757.0001", `${RUN} completed`]]);
  // The clock stops with the last watched run: nothing left to ask about.
  expect(h.ticks[0]?.stopped).toBe(true);
  await h.tick();
  expect(h.posted).toHaveLength(1);
});

test("a failed run carries its first error line and the dashboard link", async () => {
  const h = harness();
  await h.threads.runStarted(started());
  h.now("failed", { error: `Error: ${"x".repeat(400)}\n    at somewhere` });
  await h.tick();
  const text = h.posted[0]?.[2] ?? "";
  expect(text.startsWith(`${RUN} failed: Error: xxx`)).toBe(true);
  expect(text).toContain("…");
  expect(text).not.toContain("at somewhere");
  expect(text.endsWith(LOGS)).toBe(true);
});

test("a read that throws is logged, and the timer callback never rejects", async () => {
  const h = harness({
    listRuns: () => Promise.reject(new Error("world unreachable")),
  });
  await h.threads.runStarted(started());
  await expect(h.tick()).resolves.toBeUndefined();
  expect(h.errors.at(-1)).toContain("world unreachable");
  // Still watching: a World that hiccuped is not a run that ended.
  expect(h.ticks[0]?.stopped).toBe(false);
  h.threads.stop();
});

test("a post Slack refuses does not strand the watch on a finished run", async () => {
  const h = harness({
    postReply: () => Promise.reject(new Error("not_in_channel")),
  });
  await h.threads.runStarted(started());
  h.now("cancelled");
  await h.tick();
  expect(h.errors.at(-1)).toContain("not_in_channel");
  expect(h.ticks[0]?.stopped).toBe(true);
});

test("rehydration watches the mapped runs and re-announces none of them", async () => {
  const h = harness({}, [
    { runId: RUN, channel: CHANNEL, threadTs: "1757.0001" },
  ]);
  h.now("suspended");
  h.state.detail = parked("awaiting pull request review");
  await h.threads.rehydrate([RUN]);
  expect(h.ticks).toHaveLength(1);
  expect(h.logs[0]).toContain("watching 1 run(s)");

  await h.tick();
  expect(h.posted).toEqual([]);

  h.now("running");
  await h.tick();
  expect(h.posted).toEqual([[CHANNEL, "1757.0001", `${RUN} resumed`]]);
  h.threads.stop();
});

test("rehydration still reports a run that ended while the service was down", async () => {
  const h = harness({}, [
    { runId: RUN, channel: CHANNEL, threadTs: "1757.0001" },
  ]);
  h.now("completed");
  await h.threads.rehydrate([RUN]);
  await h.tick();
  expect(h.posted).toEqual([[CHANNEL, "1757.0001", `${RUN} completed`]]);
});

test("rehydration with no runs in flight asks the database nothing", async () => {
  const h = harness({}, [
    { runId: RUN, channel: CHANNEL, threadTs: "1757.0001" },
  ]);
  await h.threads.rehydrate([]);
  expect(h.ticks).toEqual([]);
  expect(h.logs).toEqual([]);
});

test("one run is watched once, however many times it is announced", async () => {
  const h = harness({}, [
    { runId: RUN, channel: CHANNEL, threadTs: "1757.0001" },
  ]);
  await h.threads.runStarted(started());
  await h.threads.rehydrate([RUN]);
  expect(h.ticks).toHaveLength(1);
  h.threads.stop();
});

test("a mapped thread resolves to the run it belongs to", async () => {
  const h = harness({}, [
    { runId: RUN, channel: CHANNEL, threadTs: "1757.0001" },
  ]);
  expect(await h.threads.threadRun(CHANNEL, "1757.0001")).toEqual({
    runId: RUN,
    pipeline: "ticket",
    status: "running",
  });
});

test("an unmapped thread, and one the database cannot answer for, are both null", async () => {
  expect(
    await harness({}, []).threads.threadRun(CHANNEL, "1757.9999"),
  ).toBeNull();
  const broken = harness({
    sql: () => {
      throw new Error("connection refused");
    },
  });
  expect(await broken.threads.threadRun(CHANNEL, "1757.0001")).toBeNull();
});

test("without the World's Postgres nothing is mapped and nothing is watched", async () => {
  const h = harness({ sql: () => null });
  await h.threads.runStarted(started());
  await h.threads.rehydrate([RUN]);
  expect(h.opened).toEqual([]);
  expect(h.ticks).toEqual([]);
  expect(await h.threads.threadRun(CHANNEL, "1757.0001")).toBeNull();
});

test("the default clock ticks at DEFAULT_POLL_MS, and stops with the watch", async () => {
  vi.useFakeTimers();
  try {
    const h = harness({ ticker: undefined });
    await h.threads.runStarted(started());
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS - 1);
    expect(h.listings).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.listings).toHaveLength(1);
    h.threads.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2);
    expect(h.listings).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a park with nothing to name still says the run is parked", () => {
  expect(milestone(detail({ status: "suspended" }), "active")).toBe(
    `${RUN} is parked`,
  );
  // The ticket claim is held for the run's whole life and names nothing.
  expect(
    milestone(detail({ status: "suspended", suspensions: [claim] }), "active"),
  ).toBe(`${RUN} is parked`);
});

test("a park reads the same however the World ordered its hooks", () => {
  const one = milestone(
    parked("waiting on a human", "awaiting review"),
    "active",
  );
  const other = milestone(
    parked("awaiting review", "waiting on a human"),
    "active",
  );
  expect(one).toBe(other);
  expect(one).toBe(`${RUN} is parked: awaiting review; waiting on a human`);
});

test("a state that has not moved is worth no words", () => {
  expect(milestone(detail({ status: "pending" }), "active")).toBe("");
  expect(milestone(detail({ status: "running" }), "active")).toBe("");
  expect(milestone(detail({ status: "running" }), null)).toBe("");
  expect(milestone(detail({ status: "running" }), "stalled")).toBe(
    `${RUN} resumed`,
  );
});
