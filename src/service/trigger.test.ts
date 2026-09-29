import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { Factory, WorkflowInputs } from "../workflow/factory.ts";

const { start, resolveIssueRef, preflightChecks } = vi.hoisted(() => ({
  start: vi.fn(async (_workflow: unknown, _args: unknown[], _options?: unknown) => ({
    runId: "wrun_test",
  })),
  preflightChecks: vi.fn(() => []),
  resolveIssueRef: vi.fn(() => {
    throw new Error("Unexpected Linear access");
  }),
}));
vi.mock("workflow/api", () => ({ start }));
const world = vi.hoisted(() => {
  const queued: unknown[] = [];
  return {
    hooks: {},
    queued,
    createRunId: () => "not this one",
    queue: async (...args: unknown[]) => {
      queued.push(args);
      return { messageId: "msg_1" };
    },
  };
});
vi.mock("workflow/runtime", () => ({ getWorld: async () => world }));
vi.mock("../checks/index.ts", () => ({
  preflightChecks,
  runChecks: async () => ({ ok: true, results: [] }),
}));
vi.mock("../providers/linear.ts", () => ({ resolveIssueRef }));

const { prepareRun, startRun } = await import("./trigger.ts");
const inputs = z.object({ ticket: z.string(), attempts: z.number().default(3) });
const factory = {
  workflows: {
    run: {
      workflow: async (input: WorkflowInputs<typeof inputs>) => input,
      inputs,
    },
  },
} satisfies Factory;

test("a ticket field is ordinary input and never triggers Linear resolution", async () => {
  start.mockClear();
  preflightChecks.mockClear();
  const result = await startRun(factory, "run", { ticket: "abc" }, "trig_manual");
  expect(result).toEqual({ kind: "started", runId: "wrun_test" });
  expect(start).toHaveBeenCalledExactlyOnceWith(factory.workflows.run.workflow, [
    { ticket: "abc", attempts: 3, triggerId: "trig_manual" },
  ]);
  expect(resolveIssueRef).not.toHaveBeenCalled();
  expect(preflightChecks).toHaveBeenCalledExactlyOnceWith({}, { ticket: "abc", attempts: 3 });
});

test("a run ID chosen by the caller is created under that ID and left for the caller to queue", async () => {
  start.mockClear();
  const runId = "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM";
  const prepared = await prepareRun(factory, "run", { ticket: "abc" });
  if (prepared.kind !== "ready") throw new Error(prepared.kind);
  expect(await prepared.launch("trig", runId)).toBe("wrun_test");
  const options = start.mock.calls[0]?.[2] as {
    world: { createRunId(): string; queue(): Promise<unknown>; hooks: unknown };
  };
  expect(options.world.createRunId()).toBe("01K3ANBZ4TQ8W9YV6H2E5C7DKM");
  // start() queues a first delivery that carries the run's input; the caller
  // queues its own, without it, once it sees the run.
  expect(await options.world.queue()).toEqual({ messageId: null });
  expect(world.queued).toEqual([]);
  expect(options.world.hooks).toBe(world.hooks);
});

test("invalid inputs cannot start a run", async () => {
  start.mockClear();
  expect((await startRun(factory, "run", { ticket: 123 }, "trig")).kind).toBe("invalid-inputs");
  expect(start).not.toHaveBeenCalled();
});
