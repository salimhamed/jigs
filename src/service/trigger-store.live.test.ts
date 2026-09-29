import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { CheckReport } from "../checks/index.ts";
import { connectRegistry, ensureRegistry, type RegistrySql } from "../steps/runtime/registry.ts";
import { triggerStore } from "./trigger-store.ts";

// A database of its own, like the registry suite: never a factory's World.
const adminUrl = new URL(
  process.env.WORKFLOW_POSTGRES_URL ?? "postgres://jigs:jigs@localhost:5439/jigs",
);
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const name = `jigs_triggers_${crypto.randomUUID().replaceAll("-", "")}`;
let db: RegistrySql;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  db = connectRegistry(url.toString(), { max: 2 });
  await ensureRegistry(db);
});
afterAll(async () => {
  await db.$client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

const T0 = new Date("2026-09-29T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const report: CheckReport = {
  ok: false,
  checks: [{ id: "x", label: "x", ok: false, reason: "no token", repair: "set it" }],
};

test("an occurrence is recorded once per trigger, and only pending rows move", async () => {
  const store = triggerStore(db, "factory-a");
  const row = {
    trigger: "pages",
    occurrence: "P1",
    state: "pending" as const,
    inputs: { page: "P1" },
  };
  expect(await store.record({ ...row, occurredAt: at(1) })).toBe(true);
  expect(await store.record({ ...row, occurredAt: at(2) })).toBe(false);
  // The same occurrence under another trigger is that trigger's own.
  expect(await store.record({ ...row, trigger: "other", occurredAt: at(1) })).toBe(true);

  await store.started("pages", "P1", "wrun_1");
  await store.failed("pages", "P1", report);
  const [only] = (
    await db.$client.query(
      "SELECT state, run_id, report FROM jigs_triggers WHERE trigger = 'pages'",
    )
  ).rows;
  expect(only).toEqual({ state: "started", run_id: "wrun_1", report: null });
});

test("pending rows come oldest first, and the summary counts and names failures", async () => {
  const store = triggerStore(db, "factory-b");
  for (const [occurrence, minute] of [
    ["late", 9],
    ["early", 3],
    ["broken", 5],
  ] as const) {
    await store.record({
      trigger: "pages",
      occurrence,
      state: "pending",
      inputs: {},
      occurredAt: at(minute),
    });
  }
  await store.record({
    trigger: "pages",
    occurrence: "stale",
    state: "skipped",
    inputs: {},
    occurredAt: at(-100),
  });
  await store.failed("pages", "broken", report);

  expect((await store.pending("pages")).map((row) => row.occurrence)).toEqual(["early", "late"]);
  const summary = await store.summary("pages", 5);
  expect(summary).toMatchObject({ lastEvent: at(9), pending: 2, failed: 1 });
  expect(summary.failures.map((row) => [row.occurrence, row.report])).toEqual([["broken", report]]);
  // Another factory sharing the database sees none of it.
  expect(await triggerStore(db, "factory-c").pending("pages")).toEqual([]);
});

test("the first enable is kept, and advancing moves only the poll window", async () => {
  const store = triggerStore(db, "factory-d");
  expect(await store.enable("pages", at(0))).toEqual({ enabledAt: at(0), polledThrough: at(0) });
  await store.advance("pages", at(5));
  expect(await store.enable("pages", at(10))).toEqual({ enabledAt: at(0), polledThrough: at(5) });
});

test("an attempt is stamped on a pending row, and a started row settles once", async () => {
  const store = triggerStore(db, "factory-e");
  await store.record({
    trigger: "pages",
    occurrence: "P1",
    state: "pending",
    inputs: {},
    occurredAt: at(0),
  });
  expect(await store.attempt("pages", "P1", at(1))).toEqual(at(1));
  // A retry keeps the first attempt's time: the lookup reaches back to it.
  expect(await store.attempt("pages", "P1", at(2))).toEqual(at(1));
  expect(await store.summary("pages", 5)).toMatchObject({ pending: 0, attempted: 1 });

  await store.started("pages", "P1", "wrun_first");
  expect(await store.unsettled("pages")).toEqual([
    { occurrence: "P1", runId: "wrun_first", startedAt: expect.any(Date) },
  ]);
  await store.settle("pages", "P1");
  expect(await store.unsettled("pages")).toEqual([]);
  await expect(store.attempt("pages", "P1", at(3))).rejects.toThrow("no longer pending");
});

test("a watched row is listed until its time, and a recorded duplicate ends the watch", async () => {
  const store = triggerStore(db, "factory-f");
  await store.record({
    trigger: "pages",
    occurrence: "P1",
    state: "pending",
    inputs: {},
    occurredAt: at(0),
  });
  await store.watchForDuplicate("pages", "P1", at(60));
  expect((await store.watched("pages", at(30))).map((row) => row.occurrence)).toEqual(["P1"]);
  expect(await store.watched("pages", at(61))).toEqual([]);

  await store.duplicated("pages", "P1", ["wrun_a", "wrun_b"]);
  expect(await store.watched("pages", at(30))).toEqual([]);
  expect((await store.summary("pages", 5)).duplicates).toEqual([
    { occurrence: "P1", runIds: ["wrun_a", "wrun_b"] },
  ]);
});
