import { SPEC_VERSION_CURRENT } from "@workflow/world";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { setWorld } from "workflow/runtime";
import { listRunSteps, runsWithActiveStep } from "./stalls.ts";

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
    specVersion: SPEC_VERSION_CURRENT,
    steps: { list: async () => ({ data: steps, cursor: null, hasMore: false }) },
  } as unknown as World);

function worldWithPages(pages: Array<Array<Record<string, unknown>>>, failure?: Error) {
  let page = 0;
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    steps: {
      list: async (_params: { pagination?: { cursor?: string } }) => {
        if (failure !== undefined && page === pages.length - 1) throw failure;
        const data = pages[page] ?? [];
        const hasMore = page < pages.length - 1;
        page += 1;
        return { data, cursor: hasMore ? `cursor-${page}` : null, hasMore };
      },
    },
  } as unknown as World);
}

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

test("an active step on a later page counts as in flight", async () => {
  worldWithPages([[step({ stepName: "first" })], [step({ stepName: "later", status: "running" })]]);
  expect(await runsWithActiveStep([RUN_A])).toEqual([RUN_A]);
});

test("all completed steps across pages have no active step", async () => {
  worldWithPages([[step()], [step({ stepName: "later", status: "failed" })]]);
  expect(await runsWithActiveStep([RUN_A])).toEqual([]);
});

test("a pending step on a later page counts as in flight", async () => {
  worldWithPages([[step()], [step({ stepName: "later", status: "pending" })]]);
  expect(await runsWithActiveStep([RUN_A])).toEqual([RUN_A]);
});

test("empty and single pages are handled", async () => {
  worldWithPages([[]]);
  expect(await listRunSteps(RUN_A)).toEqual([]);

  worldWithPages([[step()]]);
  expect(await listRunSteps(RUN_A)).toHaveLength(1);
});

test("a later-page listing failure is propagated", async () => {
  const failure = new Error("later page unavailable");
  worldWithPages([[step()], []], failure);
  await expect(listRunSteps(RUN_A)).rejects.toThrow(failure);
});
