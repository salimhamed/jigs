import { afterEach, expect, test } from "vitest";
import { setWorld } from "workflow/runtime";
import { listRunSteps, runsWithActiveStep } from "./stalls.ts";

const RUN_A = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

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
