import type { ISql } from "postgres";
import { expect, test } from "vitest";
import { deleteRunJobs, listJobRunIds, listRunDeadJobs, RunJobsLockedError } from "./queue.ts";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

const payloadFor = (runId: string) => ({
  data: Buffer.from(`\x82\x01x\x1f${runId}`, "latin1").toString("base64"),
});

const fakeSql = (rows: unknown[]) => (async () => rows) as unknown as ISql;

const job = (over: Record<string, unknown> = {}) => ({
  id: "4128",
  task: "jigs:workflow",
  attempts: 3,
  dead: true,
  lockedAt: null,
  lastError: "Queue execution failed (404): Not Found",
  createdAt: new Date("2026-09-04T10:00:00.000Z"),
  payload: payloadFor(RUN_A),
  ...over,
});

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
  expect(jobs[0]).not.toHaveProperty("lockedAt");
});

test("cancellation stops waiting when a fresh lock never settles", async () => {
  const locked = job({ lockedAt: new Date() });

  await expect(deleteRunJobs(fakeSql([locked]), RUN_A, { maxWaitMs: 0 })).rejects.toEqual(
    new RunJobsLockedError(RUN_A),
  );
});

test("cancellation removes a lock Graphile considers stale", async () => {
  const locked = job({ lockedAt: new Date(Date.now() - 4 * 60 * 60 * 1000 - 1) });

  await expect(deleteRunJobs(fakeSql([locked]), RUN_A)).resolves.toBe(1);
});
