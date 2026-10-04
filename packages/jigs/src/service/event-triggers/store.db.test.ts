import { Pool } from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import type { CheckReport } from "../../checks/index.ts";
import { databaseUrl, dbTest, postgresAdminUrl } from "../../db-test-fixtures.ts";
import { connectRegistry, ensureRegistry, type RegistrySql } from "../../steps/runtime/registry.ts";
import { occurrencesByAttribute, triggerStore } from "./store.ts";

// A database of its own, like the registry suite: never a factory's World.
const admin = new Pool({ connectionString: postgresAdminUrl.toString(), max: 1 });
const name = `jigs_triggers_${crypto.randomUUID().replaceAll("-", "")}`;
let db: RegistrySql;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
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

dbTest("an occurrence is recorded once per trigger, and only pending rows move", async () => {
  const store = triggerStore(db, "factory-a");
  const row = {
    trigger: "pages",
    occurrence: "P1",
    state: "pending" as const,
    inputs: { page: "P1" },
    attribute: "attr-P1",
  };
  expect(await store.record({ ...row, occurredAt: at(1) })).toBe(true);
  expect(await store.record({ ...row, occurredAt: at(2) })).toBe(false);
  // The same occurrence under another trigger is that trigger's own.
  expect(await store.record({ ...row, trigger: "other", occurredAt: at(1) })).toBe(true);

  await store.started("pages", "P1", "wrun_1", at(3));
  await store.failed("pages", "P1", report);
  const [only] = (
    await db.$client.query(
      "SELECT state, run_id, report FROM jigs_triggers WHERE trigger = 'pages'",
    )
  ).rows;
  expect(only).toEqual({ state: "started", run_id: "wrun_1", report: null });
});

dbTest("pending rows come oldest first, and the summary counts and names failures", async () => {
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
      attribute: `attr-${occurrence}`,
      occurredAt: at(minute),
    });
  }
  await store.record({
    trigger: "pages",
    occurrence: "stale",
    state: "skipped",
    inputs: {},
    attribute: "attr-stale",
    occurredAt: at(-100),
  });
  await store.failed("pages", "broken", report);

  expect((await store.pending("pages")).map((row) => row.occurrence)).toEqual(["early", "late"]);
  const summary = await store.summary("pages", 5);
  expect(summary).toMatchObject({ lastOccurrence: at(9), pending: 2, failed: 1 });
  expect(summary.failures.map((row) => [row.occurrence, row.report])).toEqual([["broken", report]]);
  // Another factory sharing the database sees none of it.
  expect(await triggerStore(db, "factory-c").pending("pages")).toEqual([]);
});

dbTest("the first enable is kept, and advancing moves only the cursor", async () => {
  const store = triggerStore(db, "factory-d");
  expect(await store.enable("pages", at(0))).toEqual({ enabledAt: at(0), cursor: null });
  await store.advance("pages", at(5).toISOString());
  expect(await store.enable("pages", at(10))).toEqual({
    enabledAt: at(0),
    cursor: at(5).toISOString(),
  });
});

dbTest("a source's cursor round-trips through the store as it was written", async () => {
  const store = triggerStore(db, "factory-d");
  for (const cursor of [
    { C0123ABCD: "1790723244.335019", G0123ABCD: "1790723300.000000" },
    "1790723244.335019",
    "2026-09-29T12:05:00.000Z",
    [1, "two", { three: null }],
  ]) {
    await store.advance("pages", cursor);
    expect((await store.enable("pages", at(10))).cursor).toEqual(cursor);
  }
});

dbTest(
  "a row is claimed once: the loser of a race gets nothing, and a failed row adopts its late run",
  async () => {
    const store = triggerStore(db, "factory-e");
    await store.record({
      trigger: "pages",
      occurrence: "P1",
      state: "pending",
      inputs: {},
      attribute: "attr-P1",
      occurredAt: at(0),
    });
    expect(await store.attempt("pages", "P1", at(10))).toBe(true);
    // A second claim, from another copy that read the row as unclaimed.
    expect(await store.attempt("pages", "P1", at(11))).toBe(false);
    expect((await store.pending("pages"))[0]?.attemptedAt).toEqual(at(10));
    expect(await store.summary("pages", 5)).toMatchObject({ pending: 0 });

    await store.failed("pages", "P1", report);
    await store.adoptLate("pages", "P1", "wrun_late", at(40));
    const [adopted] = await store.byAttribute("pages", ["attr-P1"]);
    expect(adopted).toMatchObject({ state: "started", runId: "wrun_late", report: null });
    expect((await store.startedSince("pages", at(40))).map((row) => row.runId)).toEqual([
      "wrun_late",
    ]);
    expect(await store.startedSince("pages", at(41))).toEqual([]);
    // A started row is never claimed again.
    expect(await store.attempt("pages", "P1", at(50))).toBe(false);
  },
);

dbTest("a row never attempted is not adopted late", async () => {
  const store = triggerStore(db, "factory-f");
  await store.record({
    trigger: "pages",
    occurrence: "P2",
    state: "pending",
    inputs: {},
    attribute: "attr-P2",
    occurredAt: at(0),
  });
  await store.failed("pages", "P2", report);
  await store.adoptLate("pages", "P2", "wrun_x", at(1));
  expect((await store.byAttribute("pages", ["attr-P2"]))[0]?.state).toBe("failed");
  expect(await store.byAttribute("pages", [])).toEqual([]);
});

dbTest(
  "rows are found by attribute across every trigger, and only in their own factory",
  async () => {
    const row = (trigger: string, attribute: string) => ({
      trigger,
      occurrence: attribute,
      state: "started" as const,
      inputs: { channel: "C1", ts: "1.0" },
      attribute,
      occurredAt: at(0),
    });
    await triggerStore(db, "factory-g").record(row("answers", "attr-g1"));
    await triggerStore(db, "factory-g").record(row("pages", "attr-g2"));
    await triggerStore(db, "factory-h").record(row("answers", "attr-g3"));
    const found = await occurrencesByAttribute(db, "factory-g", ["attr-g1", "attr-g2", "attr-g3"]);
    expect(found.map((r) => r.trigger).sort()).toEqual(["answers", "pages"]);
    expect(await occurrencesByAttribute(db, "factory-g", [])).toEqual([]);
  },
);
