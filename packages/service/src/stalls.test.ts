import type { ISql } from "postgres";
import { afterEach, expect, test } from "vitest";
import { setWorld } from "workflow/runtime";
import {
  listDeadJobs,
  listRunDeadJobs,
  listRunSteps,
  runsWithActiveStep,
} from "./stalls";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
const RUN_B = "wrun_01K3ANC1P0R4S6TXZ8B3F5G7HJ";

type World = Parameters<typeof setWorld>[0];

afterEach(() => setWorld(undefined));

const step = (over: Record<string, unknown> = {}) => ({
  runId: RUN_A,
  stepId: "01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  stepName: "step//./steps/jigs//worktree",
  status: "completed",
  attempt: 1,
  createdAt: new Date("2026-09-04T10:00:00.000Z"),
  updatedAt: new Date("2026-09-04T10:00:01.000Z"),
  startedAt: new Date("2026-09-04T10:00:00.000Z"),
  completedAt: new Date("2026-09-04T10:00:01.000Z"),
  ...over,
});

const worldWithSteps = (steps: Array<Record<string, unknown>>) =>
  setWorld({
    steps: { list: async () => ({ data: steps }) },
  } as unknown as World);

// graphile stores the queue message body base64-encoded in the job payload;
// the run id is an ASCII ULID inside it whichever way it was serialized.
const payloadFor = (runId: string) => ({
  data: Buffer.from(`\x82\x01x\x1f${runId}`, "latin1").toString("base64"),
});

const fakeSql = (rows: unknown[]) => (async () => rows) as unknown as ISql;

const deadJob = (over: Record<string, unknown> = {}) => ({
  id: "4128",
  task: "jigs:workflow",
  attempts: 3,
  lastError: "Queue execution failed (404): Not Found",
  createdAt: new Date("2026-09-04T10:00:00.000Z"),
  payload: payloadFor(RUN_A),
  ...over,
});

test("a run's steps are reported oldest first, with a null for what has not happened", async () => {
  worldWithSteps([
    step({
      stepName: "second",
      createdAt: new Date("2026-09-04T10:00:05.000Z"),
      status: "running",
      attempt: 2,
      completedAt: undefined,
      error: { message: "the harness exited 1" },
    }),
    step({ stepName: "first" }),
  ]);
  expect(await listRunSteps(RUN_A)).toEqual([
    {
      name: "first",
      status: "completed",
      attempt: 1,
      startedAt: "2026-09-04T10:00:00.000Z",
      completedAt: "2026-09-04T10:00:01.000Z",
      error: null,
    },
    {
      name: "second",
      status: "running",
      attempt: 2,
      startedAt: "2026-09-04T10:00:00.000Z",
      completedAt: null,
      error: "the harness exited 1",
    },
  ]);
});

test("a run whose every step is terminal has nothing in flight", async () => {
  worldWithSteps([step(), step({ stepName: "other", status: "failed" })]);
  expect(await runsWithActiveStep([RUN_A])).toEqual([]);
});

test("a pending step counts as in flight, like a running one", async () => {
  worldWithSteps([step({ status: "pending" })]);
  expect(await runsWithActiveStep([RUN_A])).toEqual([RUN_A]);
});

test("a dead job names the run its queue message body carries", async () => {
  const jobs = await listDeadJobs(fakeSql([deadJob()]));
  expect(jobs).toEqual([
    {
      id: "4128",
      task: "jigs:workflow",
      attempts: 3,
      lastError: "Queue execution failed (404): Not Found",
      createdAt: "2026-09-04T10:00:00.000Z",
      runId: RUN_A,
    },
  ]);
});

test("a job whose payload names no run is reported without one", async () => {
  const jobs = await listDeadJobs(fakeSql([deadJob({ payload: null })]));
  expect(jobs[0]?.runId).toBeNull();
});

test("the per-run listing keeps only that run's jobs, and drops the payload", async () => {
  const jobs = await listRunDeadJobs(
    fakeSql([deadJob(), deadJob({ id: "4129", payload: payloadFor(RUN_B) })]),
    RUN_B,
  );
  expect(jobs.map((job) => job.id)).toEqual(["4129"]);
  expect(jobs[0]).not.toHaveProperty("payload");
});
