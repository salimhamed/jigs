import type { ISql } from "postgres";
import { expect, test } from "vitest";
import {
  ensureSlackThreads,
  getRunForSlackThread,
  getSlackThreadForRun,
  insertSlackThread,
  listSlackThreadsForRuns,
  type SlackThreadRow,
} from "./threads-table";

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

interface Query {
  text: string;
  values: unknown[];
}

/** A postgres.js tag that records what it was asked and answers with what the
 *  test put on the table. */
function fakeSql(rows: SlackThreadRow[] = []) {
  const queries: Query[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({
      text: strings.join("?").replace(/\s+/g, " ").trim(),
      values,
    });
    return Promise.resolve(rows);
  }) as unknown as ISql;
  return { sql, queries };
}

const row = (over: Partial<SlackThreadRow> = {}): SlackThreadRow => ({
  runId: RUN,
  channel: "C0RUNS",
  threadTs: "1757.0001",
  ...over,
});

test("ensure creates the table and the index the thread lookup reads", async () => {
  const { sql, queries } = fakeSql();
  await ensureSlackThreads(sql);
  expect(queries).toHaveLength(2);
  expect(queries[0]?.text).toContain(
    "CREATE TABLE IF NOT EXISTS jigs_slack_threads",
  );
  expect(queries[0]?.text).toContain("run_id text PRIMARY KEY");
  expect(queries[1]?.text).toContain("CREATE INDEX IF NOT EXISTS");
  expect(queries[1]?.text).toContain("(channel, thread_ts, created_at DESC)");
});

test("a run's thread is inserted once and never moved by a second start", async () => {
  const { sql, queries } = fakeSql();
  await insertSlackThread(sql, row());
  expect(queries[0]?.text).toContain("ON CONFLICT (run_id) DO NOTHING");
  expect(queries[0]?.values).toEqual([RUN, "C0RUNS", "1757.0001"]);
});

test("a run's thread reads back by run id", async () => {
  const { sql, queries } = fakeSql([row()]);
  expect(await getSlackThreadForRun(sql, RUN)).toEqual(row());
  expect(queries[0]?.values).toEqual([RUN]);
});

test("a run with no thread reads back as null, not an empty row", async () => {
  const { sql } = fakeSql([]);
  expect(await getSlackThreadForRun(sql, RUN)).toBeNull();
  expect(await getRunForSlackThread(sql, "C0RUNS", "1757.0001")).toBeNull();
});

test("a thread resolves to the newest run started from it", async () => {
  const { sql, queries } = fakeSql([row()]);
  expect(await getRunForSlackThread(sql, "C0RUNS", "1757.0001")).toEqual(row());
  expect(queries[0]?.text).toContain("ORDER BY created_at DESC LIMIT 1");
  expect(queries[0]?.values).toEqual(["C0RUNS", "1757.0001"]);
});

test("the threads of the runs still in flight are asked for by id", async () => {
  const other = row({ runId: "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ" });
  const { sql, queries } = fakeSql([row(), other]);
  expect(await listSlackThreadsForRuns(sql, [RUN, other.runId])).toEqual([
    row(),
    other,
  ]);
  expect(queries[0]?.values).toEqual([[RUN, other.runId]]);
});

test("no runs in flight asks the database nothing", async () => {
  const { sql, queries } = fakeSql([row()]);
  expect(await listSlackThreadsForRuns(sql, [])).toEqual([]);
  expect(queries).toEqual([]);
});
