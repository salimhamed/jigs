import { afterAll, expect, test } from "vitest";
import { connectRegistry } from "../worktrees/registry";
import {
  ensureSlackThreads,
  getRunForSlackThread,
  getSlackThreadForRun,
  insertSlackThread,
  listSlackThreadsForRuns,
} from "./threads-table";

const sql = connectRegistry(
  process.env.WORKFLOW_POSTGRES_URL ??
    "postgres://jigs:jigs@localhost:5439/jigs",
  { max: 1 },
);

const first = `wrun_live_${crypto.randomUUID()}`;
const second = `wrun_live_${crypto.randomUUID()}`;
const channel = "C0LIVE";
const threadTs = `${Date.now()}.0001`;

afterAll(async () => {
  await sql`DELETE FROM jigs_slack_threads WHERE run_id IN (${first}, ${second})`;
  await sql.end();
});

test("ensureSlackThreads is idempotent", async () => {
  await ensureSlackThreads(sql);
  await expect(ensureSlackThreads(sql)).resolves.toBeUndefined();
});

test("a run's thread round-trips both ways", async () => {
  await ensureSlackThreads(sql);
  await insertSlackThread(sql, { runId: first, channel, threadTs });
  expect(await getSlackThreadForRun(sql, first)).toEqual({
    runId: first,
    channel,
    threadTs,
  });
  expect(await getRunForSlackThread(sql, channel, threadTs)).toEqual({
    runId: first,
    channel,
    threadTs,
  });
});

test("a second start from the same thread wins the reverse lookup", async () => {
  await ensureSlackThreads(sql);
  await insertSlackThread(sql, { runId: first, channel, threadTs });
  await insertSlackThread(sql, { runId: second, channel, threadTs });
  const row = await getRunForSlackThread(sql, channel, threadTs);
  expect(row?.runId).toBe(second);
  expect(
    (await listSlackThreadsForRuns(sql, [first, second])).map((r) => r.runId),
  ).toEqual([first, second]);
});

test("re-inserting a run leaves its thread where it was", async () => {
  await ensureSlackThreads(sql);
  await insertSlackThread(sql, { runId: first, channel, threadTs });
  await insertSlackThread(sql, {
    runId: first,
    channel: "C0OTHER",
    threadTs: "9999.0001",
  });
  expect(await getSlackThreadForRun(sql, first)).toEqual({
    runId: first,
    channel,
    threadTs,
  });
});
