import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { Factory, WorkflowInputs } from "../workflow/factory.ts";

const { start, resolveIssueRef, preflightChecks } = vi.hoisted(() => ({
  start: vi.fn(async (_workflow: unknown, _args: unknown[]) => ({ runId: "wrun_test" })),
  preflightChecks: vi.fn(() => []),
  resolveIssueRef: vi.fn(() => {
    throw new Error("Unexpected Linear access");
  }),
}));
vi.mock("workflow/api", () => ({ start }));
vi.mock("../checks/index.ts", () => ({
  preflightChecks,
  runChecks: async () => ({ ok: true, results: [] }),
}));
vi.mock("../providers/linear.ts", () => ({ resolveIssueRef }));

const { startRun } = await import("./trigger.ts");
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
  expect(start).toHaveBeenCalledExactlyOnceWith(
    factory.workflows.run.workflow,
    [{ ticket: "abc", attempts: 3, triggerId: "trig_manual" }],
    {
      attributes: {
        "$jigs.cleanup.v1.directive": "automatic",
        "$jigs.cleanup.v1.state": '{"status":"waiting"}',
      },
      allowReservedAttributes: true,
    },
  );
  expect(resolveIssueRef).not.toHaveBeenCalled();
  expect(preflightChecks).toHaveBeenCalledExactlyOnceWith({}, { ticket: "abc", attempts: 3 });
});

test("invalid inputs cannot start a run", async () => {
  start.mockClear();
  expect((await startRun(factory, "run", { ticket: 123 }, "trig")).kind).toBe("invalid-inputs");
  expect(start).not.toHaveBeenCalled();
});
