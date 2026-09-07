import { expect, test } from "vitest";
import { z } from "zod";
import type { Factory, Schedule } from "./factory.ts";
import type { RunRow } from "./runs.ts";
import {
  fireSchedule,
  listSchedules,
  scheduleChecks,
  startSchedules,
} from "./schedules.ts";
import type { StartRunResult } from "./trigger.ts";

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

const factory = (schedules: NonNullable<Factory["schedules"]>): Factory => ({
  pipelines: {
    sweep: {
      pipeline: async () => undefined,
      inputs: z.object({
        target: z.string(),
        deep: z.boolean().default(false),
      }),
    },
  },
  schedules,
});

const nightlySchedule: Schedule = {
  pipeline: "sweep",
  cron: "0 3 * * *",
  inputs: { target: "api" },
};
const nightly = factory({ nightly: nightlySchedule });

const row = (over: Partial<RunRow> = {}): RunRow => ({
  runId: RUN,
  pipeline: "sweep",
  status: "running",
  trigger: "schedule:nightly",
  createdAt: "2026-08-26T03:00:00.000Z",
  ...over,
});

const started: StartRunResult = { kind: "started", runId: RUN };

async function check(id: string, factory: Factory) {
  const found = scheduleChecks(factory).find((c) => c.id === id);
  if (found === undefined) throw new Error(`no ${id} check`);
  return { label: found.label, ...(await found.run()) };
}

test("a schedule naming a pipeline this factory does not have fails its check", async () => {
  const result = await check(
    "schedule.nightly",
    factory({
      nightly: { pipeline: "swep", cron: "0 3 * * *", inputs: {} },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toContain('"swep"');
  expect(result.ok === false && result.repair).toBe(
    "set schedules.nightly.pipeline in jigs.config.ts to one of: sweep",
  );
});

test("a schedule name carrying a colon fails its check — it would answer for another", async () => {
  const result = await check(
    "schedule.nightly:sweep",
    factory({
      "nightly:sweep": {
        pipeline: "sweep",
        cron: "0 3 * * *",
        inputs: { target: "a" },
      },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toContain('contains ":"');
  expect(result.ok === false && result.repair).toContain(
    'rename the "nightly:sweep" schedule in jigs.config.ts',
  );
});

test("a cron croner rejects fails its check", async () => {
  const result = await check(
    "schedule.nightly",
    factory({
      nightly: { pipeline: "sweep", cron: "0 3 * *", inputs: { target: "a" } },
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
        pipeline: "sweep",
        cron: "0 0 3 * * *",
        inputs: { target: "a" },
      },
    }),
  );
  expect(result.ok).toBe(false);
});

test("inputs the pipeline's schema rejects fail its check", async () => {
  const result = await check(
    "schedule.nightly",
    factory({
      nightly: { pipeline: "sweep", cron: "0 3 * * *", inputs: { deep: 1 } },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toContain("target");
  expect(result.ok === false && result.repair).toBe(
    "fix schedules.nightly.inputs in jigs.config.ts to satisfy the sweep pipeline's inputs",
  );
});

test("a schedule whose pipeline, cron and inputs all hold passes", async () => {
  const result = await check("schedule.nightly", nightly);
  expect(result).toEqual({ label: "schedule nightly", ok: true });
});

test("a factory declaring no schedules contributes no checks", () => {
  expect(scheduleChecks({ pipelines: {} })).toEqual([]);
});

test("a malformed schedule is logged with its repair and left unscheduled", () => {
  const lines: string[] = [];
  const jobs = startSchedules(
    factory({
      broken: { pipeline: "sweep", cron: "always", inputs: { target: "a" } },
      nightly: {
        pipeline: "sweep",
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
  expect(lines).toEqual([
    `[schedule] nightly skipped: run ${RUN} is still active`,
  ]);
});

test("a suspended run of the same schedule blocks the next fire too", async () => {
  let starts = 0;
  await fireSchedule(nightly, "nightly", nightlySchedule, {
    listRuns: async () => [row({ status: "suspended" })],
    startRun: async () => {
      starts += 1;
      return started;
    },
    log: () => {},
  });
  expect(starts).toBe(0);
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
    startRun: async (_factory, _pipeline, _inputs, triggerId) => {
      triggerIds.push(triggerId);
      return started;
    },
    log: () => {},
  });
  expect(triggerIds).toHaveLength(1);
  expect(triggerIds[0]).toMatch(
    /^schedule:nightly:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
  );
});

test("a fire triggers its pipeline with the schedule's declared inputs", async () => {
  const lines: string[] = [];
  const calls: Array<[string, unknown]> = [];
  await fireSchedule(nightly, "nightly", nightlySchedule, {
    listRuns: async () => [],
    startRun: async (_factory, pipeline, inputs) => {
      calls.push([pipeline, inputs]);
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
            id: "core.github-token",
            label: "GitHub token",
            ok: false,
            reason: "GITHUB_TOKEN is not set in the service's environment",
            repair: "set GITHUB_TOKEN in the factory repo's .env",
          },
        ],
      },
    }),
    log: (line) => lines.push(line),
  });
  expect(lines).toEqual([
    "[schedule] nightly not fired: preflight failed\nGitHub token: GITHUB_TOKEN is not set in the service's environment\n  → set GITHUB_TOKEN in the factory repo's .env",
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
  expect(lines).toEqual([
    "[schedule] nightly failed: Error: world unreachable",
  ]);
});

test("the listing carries the next occurrence and the active run", async () => {
  const views = await listSchedules(nightly, {
    listRuns: async () => [row()],
  });
  expect(views).toHaveLength(1);
  const view = views[0];
  expect(view).toMatchObject({
    name: "nightly",
    pipeline: "sweep",
    cron: "0 3 * * *",
    active: RUN,
  });
  expect(new Date(view?.next ?? "").getTime()).toBeGreaterThan(Date.now());
});

test("a schedule whose cron does not parse has no next occurrence to report", async () => {
  const views = await listSchedules(
    factory({
      broken: { pipeline: "sweep", cron: "always", inputs: { target: "a" } },
    }),
    { listRuns: async () => [] },
  );
  expect(views[0]).toMatchObject({ next: null, active: null });
});

test("a factory declaring no schedules lists none and reads no runs", async () => {
  const views = await listSchedules(
    { pipelines: {} },
    {
      listRuns: async () => {
        throw new Error("the run listing should not be reached");
      },
    },
  );
  expect(views).toEqual([]);
});
