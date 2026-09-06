import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { Factory } from "./factory";
import type { RunStarted } from "./run-events";

const RUN = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";

// File-scoped: what is under test is the announcement a created run makes, so
// the run has to be created without a World, a queue or a preflight probe.
const { start } = vi.hoisted(() => ({
  start: vi.fn(async () => ({ runId: RUN })),
}));
vi.mock("workflow/api", () => ({
  start,
  getRun: () => ({ exists: Promise.resolve(false) }),
  getHookByToken: async () => ({ metadata: null }),
  resumeHook: async () => ({}),
}));
vi.mock("./preflight", () => ({
  preflight: async () => ({ ok: true, checks: [] }),
  factoryRoot: () => "/tmp/factory",
}));

const { onRunStarted } = await import("./run-events");
const { startRun } = await import("./trigger");

const factory: Factory = {
  pipelines: {
    ticket: { pipeline: async () => undefined, inputs: z.object({}) },
  },
};

function listening() {
  const heard: RunStarted[] = [];
  const stop = onRunStarted((event) => heard.push(event));
  return { heard, stop };
}

test("a created run announces itself with its pipeline, trigger and dashboard link", async () => {
  vi.stubEnv("JIGS_DASHBOARD_PORT", "3001");
  const { heard, stop } = listening();
  expect(await startRun(factory, "ticket", {}, "manual-1")).toEqual({
    kind: "started",
    runId: RUN,
  });
  stop();
  expect(heard).toEqual([
    {
      runId: RUN,
      pipeline: "ticket",
      triggerId: "manual-1",
      logs: `http://localhost:3001/run/${RUN}`,
    },
  ]);
  vi.unstubAllEnvs();
});

test("an origin the caller passed is carried onto the event", async () => {
  const { heard, stop } = listening();
  await startRun(factory, "ticket", {}, "manual-2", {
    kind: "slack-thread",
    channel: "C0RUNS",
    threadTs: "1757.0001",
  });
  stop();
  expect(heard[0]?.origin).toEqual({
    kind: "slack-thread",
    channel: "C0RUNS",
    threadTs: "1757.0001",
  });
});

test("a launch that never became a run announces nothing", async () => {
  const { heard, stop } = listening();
  expect(await startRun(factory, "nope", {}, "manual-3")).toMatchObject({
    kind: "unknown-pipeline",
  });
  stop();
  expect(heard).toEqual([]);
});

test("a subscriber that throws does not cost the caller its run", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const stop = onRunStarted(() => {
    throw new Error("no thread for you");
  });
  expect(await startRun(factory, "ticket", {}, "manual-4")).toEqual({
    kind: "started",
    runId: RUN,
  });
  stop();
  error.mockRestore();
});
