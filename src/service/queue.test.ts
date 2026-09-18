import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, QueryConfig } from "pg";
import { expect, test } from "vitest";
import { deleteRunJobs, listJobRunIds, listRunDeadJobs, RunJobsLockedError } from "./queue.ts";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

const payloadFor = (runId: string) => ({
  data: Buffer.from(`\x82\x01x\x1f${runId}`, "latin1").toString("base64"),
});

const fakeSql = (rows: unknown[]) => drizzle({ query: async () => ({ rows }) } as unknown as Pool);

const job = (over: Record<string, unknown> = {}) => ({
  id: "4128",
  task: "jigs:workflow",
  attempts: 3,
  dead: true,
  lastError: "Queue execution failed (404): Not Found",
  createdAt: new Date("2026-09-04T10:00:00.000Z"),
  payload: payloadFor(RUN_A),
  ...over,
});

interface QueuedRow {
  id: string;
  lockedAt: Date | null;
  [column: string]: unknown;
}

const queued = (over: Partial<QueuedRow> = {}): QueuedRow => ({
  ...job(),
  lockedAt: null,
  ...over,
});

/** A queue that answers the scan and applies the delete's own lock test, so a
 *  test can move a row under cleanup's feet the way a worker does. */
function fakeQueue(rows: QueuedRow[], onScan: (rows: QueuedRow[]) => void = () => undefined) {
  let present = [...rows];
  const sql = drizzle({
    query: (config: QueryConfig, values: unknown[]) => {
      if (!config.text.includes("DELETE")) {
        const scanned = [...present];
        onScan(present);
        return Promise.resolve({ rows: scanned });
      }
      const [ids, staleBefore] = values as [string[], Date];
      const removable = (row: QueuedRow) =>
        ids.includes(row.id) && (row.lockedAt === null || row.lockedAt < staleBefore);
      const removed = present.filter(removable);
      present = present.filter((row) => !removable(row));
      return Promise.resolve({ rows: removed.map((row) => ({ id: row.id })) });
    },
  } as unknown as Pool);
  return { sql, remaining: () => present };
}

test("a job is sorted into dead or live by the run its message body names", async () => {
  const jobs = await listJobRunIds(
    fakeSql([job(), job({ id: "4129", dead: false, payload: payloadFor(RUN_B) })]),
  );
  expect(jobs).toEqual({ dead: [RUN_A], live: [RUN_B] });
});

test("a job whose payload names no run belongs to neither list", async () => {
  const jobs = await listJobRunIds(fakeSql([job({ payload: null })]));
  expect(jobs).toEqual({ dead: [], live: [] });
});

test("the per-run listing keeps that run's dead jobs, and drops its internal columns", async () => {
  const jobs = await listRunDeadJobs(
    fakeSql([
      job({ id: "4127", dead: false, payload: payloadFor(RUN_B) }),
      job({ id: "4129", payload: payloadFor(RUN_B) }),
      job(),
    ]),
    RUN_B,
  );
  expect(jobs.map((row) => row.id)).toEqual(["4129"]);
  expect(jobs[0]).not.toHaveProperty("payload");
  expect(jobs[0]).not.toHaveProperty("dead");
});

test("cancellation removes only the run's own jobs", async () => {
  const queue = fakeQueue([queued(), queued({ id: "4129", payload: payloadFor(RUN_B) })]);

  await expect(deleteRunJobs(queue.sql, RUN_A)).resolves.toBe(1);
  expect(queue.remaining().map((row) => row.id)).toEqual(["4129"]);
});

test("a delivery that takes a row between the scan and the delete keeps it", async () => {
  const queue = fakeQueue([queued()], (rows) => {
    for (const row of rows) row.lockedAt = new Date();
  });

  await expect(deleteRunJobs(queue.sql, RUN_A, { maxWaitMs: 0 })).rejects.toEqual(
    new RunJobsLockedError(RUN_A),
  );
  expect(queue.remaining()).toHaveLength(1);
});

test("cancellation also removes a job enqueued while it waited", async () => {
  let arrived = false;
  const queue = fakeQueue([queued()], (rows) => {
    if (arrived) return;
    arrived = true;
    rows.push(queued({ id: "4129" }));
  });

  await expect(deleteRunJobs(queue.sql, RUN_A)).resolves.toBe(2);
  expect(queue.remaining()).toHaveLength(0);
});

test("cancellation stops waiting when a fresh lock never settles", async () => {
  const queue = fakeQueue([queued({ lockedAt: new Date() })]);

  await expect(deleteRunJobs(queue.sql, RUN_A, { maxWaitMs: 0 })).rejects.toEqual(
    new RunJobsLockedError(RUN_A),
  );
});

test("cancellation removes a lock Graphile considers stale", async () => {
  const queue = fakeQueue([queued({ lockedAt: new Date(Date.now() - 4 * 60 * 60 * 1000 - 1) })]);

  await expect(deleteRunJobs(queue.sql, RUN_A)).resolves.toBe(1);
  expect(queue.remaining()).toHaveLength(0);
});
