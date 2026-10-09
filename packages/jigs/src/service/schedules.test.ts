import { afterAll, expect, test, vi } from "vitest";
import { z } from "zod";
import type { Factory, Schedule } from "../workflow/factory.ts";
import type { StartRunResult } from "./launch.ts";
import type { RunRow } from "./runs.ts";
import { fireSchedule, listSchedules, scheduleChecks, startSchedules } from "./schedules.ts";

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

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

const factory = (schedules: NonNullable<Factory["schedules"]>): Factory => ({
  workflows: {
    sweep: {
      workflow: async () => undefined,
      inputs: z.object({
        target: z.string(),
        deep: z.boolean().default(false),
      }),
    },
  },
  schedules,
});

const nightlySchedule: Schedule = {
  active: true,
  workflow: "sweep",
  cron: "0 3 * * *",
  inputs: { target: "api" },
};
const nightly = factory({ nightly: nightlySchedule });

const row = (over: Partial<RunRow> = {}): RunRow => ({
  runId: RUN,
  workflow: "sweep",
  status: "running",
  trigger: "schedule:nightly",
  source: null,
  ticket: null,
  createdAt: "2026-08-26T03:00:00.000Z",
  lastActivityAt: "2026-08-26T03:00:00.000Z",
  steps: 0,
  lastStep: null,
  suspensions: [],
  workflowName: "workflow//./workflows/sweep//sweep",
  claim: null,
  resources: [],
  ...over,
});

const started: StartRunResult = { kind: "started", runId: RUN };

async function check(id: string, factory: Factory) {
  const found = scheduleChecks(factory).find((c) => c.id === id);
  if (found === undefined) throw new Error(`no ${id} check`);
  return { label: found.label, ...(await found.run()) };
}

test("a cron croner rejects fails its check", async () => {
  const result = await check(
    "schedule.nightly",
    factory({
      nightly: { active: true, workflow: "sweep", cron: "0 3 * *", inputs: { target: "a" } },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.repair).toContain(
    "fix schedules.nightly.cron in jigs.config.ts",
  );
});

test("a six-field cron is a rejection, not a seconds field", async () => {
  const result = await check(
    "schedule.nightly",
    factory({
      nightly: {
        active: true,
        workflow: "sweep",
        cron: "0 0 3 * * *",
        inputs: { target: "a" },
      },
    }),
  );
  expect(result.ok).toBe(false);
});

test("inputs the workflow's schema rejects fail its check", async () => {
  const result = await check(
    "schedule.nightly",
    factory({
      nightly: { active: true, workflow: "sweep", cron: "0 3 * * *", inputs: { deep: 1 } },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toContain("target");
  expect(result.ok === false && result.repair).toBe(
    "fix schedules.nightly.inputs in jigs.config.ts to satisfy the sweep workflow's inputs",
  );
});

test("a schedule whose workflow, cron and inputs all hold passes", async () => {
  const result = await check("schedule.nightly", nightly);
  expect(result).toEqual({ label: "schedule nightly", ok: true });
});

test("a factory declaring no schedules contributes no checks", () => {
  expect(scheduleChecks({ workflows: {} })).toEqual([]);
});

test("a malformed schedule is logged with its repair and left unscheduled", () => {
  const lines: string[] = [];
  const jobs = startSchedules(
    factory({
      broken: { active: true, workflow: "sweep", cron: "always", inputs: { target: "a" } },
      nightly: {
        active: true,
        workflow: "sweep",
        cron: "0 3 * * *",
        inputs: { target: "a" },
      },
    }),
    { log: (line) => lines.push(line) },
  );
  try {
    // The valid one still started: one bad declaration does not cost the
    // service its other schedules.
    expect(jobs).toHaveLength(1);
    expect(lines[0]).toContain("[schedule] broken not scheduled:");
    expect(lines[1]).toContain("fix schedules.broken.cron");
    expect(lines[2]).toContain("[schedule] nightly scheduled: 0 3 * * *");
  } finally {
    for (const job of jobs) job.stop();
  }
});

test("an inactive schedule is logged once, never scheduled or checked, and listed as inactive", async () => {
  const lines: string[] = [];
  const quiet = factory({ off: { ...nightlySchedule, active: false, cron: "always" } });
  const jobs = startSchedules(quiet, { log: (line) => lines.push(line) });
  expect(jobs).toEqual([]);
  expect(lines).toEqual(["[schedule] off inactive"]);
  expect(scheduleChecks(quiet)).toEqual([]);
  expect(await listSchedules(quiet, { listRuns: async () => [] })).toMatchObject([
    { name: "off", state: "inactive" },
  ]);
});

test("a fire while a run of the same schedule is active is skipped, naming the run", async () => {
  const lines: string[] = [];
  let starts = 0;
  await fireSchedule(nightly, "nightly", nightlySchedule, {
    listRuns: async () => [row()],
    startRun: async () => {
      starts += 1;
      return started;
    },
    log: (line) => lines.push(line),
  });
  expect(starts).toBe(0);
  expect(lines).toEqual([`[schedule] nightly skipped: run ${RUN} is still active`]);
});

test("a terminal run of the same schedule does not block the next fire", async () => {
  const triggerIds: string[] = [];
  await fireSchedule(nightly, "nightly", nightlySchedule, {
    listRuns: async () => [
      row({ status: "completed" }),
      // Another schedule's run in flight is not this schedule's business.
      row({ trigger: "schedule:weekly" }),
      row({ trigger: "manual" }),
    ],
    startRun: async (_factory, _workflow, _inputs, triggerId) => {
      triggerIds.push(triggerId);
      return started;
    },
    log: () => {},
  });
  expect(triggerIds).toHaveLength(1);
  expect(triggerIds[0]).toMatch(/^schedule:nightly:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("a fire triggers its workflow with the schedule's declared inputs", async () => {
  const lines: string[] = [];
  const calls: Array<[string, unknown]> = [];
  await fireSchedule(nightly, "nightly", nightlySchedule, {
    listRuns: async () => [],
    startRun: async (_factory, workflow, inputs) => {
      calls.push([workflow, inputs]);
      return started;
    },
    log: (line) => lines.push(line),
  });
  expect(calls).toEqual([["sweep", { target: "api" }]]);
  expect(lines).toEqual([`[schedule] nightly fired: run ${RUN} of sweep`]);
});

test("a failed preflight is logged with its repairs under the schedule's name, and starts nothing", async () => {
  const lines: string[] = [];
  await fireSchedule(nightly, "nightly", nightlySchedule, {
    listRuns: async () => [],
    startRun: async () => ({
      kind: "preflight-failed",
      report: {
        ok: false,
        checks: [
          {
            id: "github.installations",
            label: "GitHub installations",
            ok: false,
            reason: "the hub gave no GitHub token: 401 Unauthorized",
            repair: "check hub.url in jigs.config.ts and that the hub is running",
          },
        ],
      },
    }),
    log: (line) => lines.push(line),
  });
  expect(lines).toEqual([
    "[schedule] nightly not fired: preflight failed\nGitHub installations: the hub gave no GitHub token: 401 Unauthorized\n  → check hub.url in jigs.config.ts and that the hub is running",
  ]);
});

test("a trigger path that throws is logged, not left to take the service down", async () => {
  const lines: string[] = [];
  await fireSchedule(nightly, "nightly", nightlySchedule, {
    listRuns: async () => [],
    startRun: async () => {
      throw new Error("world unreachable");
    },
    log: (line) => lines.push(line),
  });
  expect(lines).toEqual(["[schedule] nightly failed: Error: world unreachable"]);
});

test("the listing carries the next occurrence and the active run", async () => {
  const views = await listSchedules(nightly, {
    listRuns: async () => [row()],
  });
  expect(views).toHaveLength(1);
  const view = views[0];
  expect(view).toMatchObject({
    name: "nightly",
    workflow: "sweep",
    cron: "0 3 * * *",
    active: RUN,
  });
  expect(new Date(view?.next ?? "").getTime()).toBeGreaterThan(Date.now());
});

test("a schedule whose cron does not parse has no next occurrence to report", async () => {
  const views = await listSchedules(
    factory({
      broken: { active: true, workflow: "sweep", cron: "always", inputs: { target: "a" } },
    }),
    { listRuns: async () => [] },
  );
  expect(views[0]).toMatchObject({ next: null, active: null });
});

test("a factory declaring no schedules lists none and reads no runs", async () => {
  const views = await listSchedules(
    { workflows: {} },
    {
      listRuns: async () => {
        throw new Error("the run listing should not be reached");
      },
    },
  );
  expect(views).toEqual([]);
});
