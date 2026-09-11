// What the trigger injects, held to the types a factory declares its workflow
// bodies with. The shape is the typecheck's to guard: trigger.ts declares each
// injected object `satisfies Injected`/`TicketInjected`, the two types
// WorkflowInputs and TicketWorkflowInputs are built from, so a field on one
// side and not the other fails to compile. These assertions guard the values —
// which of the two shapes each workflow is handed, and what lands in it.

import { expect, test, vi } from "vitest";
import { z } from "zod";
import type {
  Factory,
  TicketWorkflowInputs,
  WorkflowInputs,
} from "../blocks/factory.ts";
import { ticketInput } from "../blocks/factory.ts";

const ISSUE_ID = "68bc9696-35d5-442d-ab56-214c8cfefbec";

const { start } = vi.hoisted(() => ({
  start: vi.fn(async (_workflow: unknown, _args: unknown[]) => ({
    runId: "wrun_01K3ANBZ4TQ8W9YV6H2E5C7DKM",
  })),
}));
vi.mock("workflow/api", () => ({ start }));

// Preflight and the Linear lookup are the trigger's other two halves, tested
// where they live; here they stand aside so the run is always created.
vi.mock("../checks/index.ts", () => ({
  preflightChecks: () => [],
  runChecks: async () => ({ ok: true, results: [] }),
}));
vi.mock("../providers/linear.ts", () => ({
  resolveIssueRef: async () => ({ id: ISSUE_ID, identifier: "AGE-342" }),
}));

const { startRun } = await import("./trigger.ts");

const shipInputs = z.object({ ticket: ticketInput, binding: z.string() });
const sweepInputs = z.object({ olderThanDays: z.number().default(7) });

const factory = {
  workflows: {
    ship: {
      workflow: async (inputs: TicketWorkflowInputs<typeof shipInputs>) => [
        inputs.triggerId,
        inputs.issueId,
        inputs.identifier,
        inputs.binding,
      ],
      inputs: shipInputs,
    },
    sweep: {
      workflow: async (inputs: WorkflowInputs<typeof sweepInputs>) => [
        inputs.triggerId,
        inputs.olderThanDays,
      ],
      inputs: sweepInputs,
    },
  },
} satisfies Factory;

test("a ticket workflow is handed triggerId and the resolved pair", async () => {
  start.mockClear();
  const result = await startRun(
    factory,
    "ship",
    { ticket: "AGE-342", binding: "api" },
    "trig_manual",
  );

  expect(result.kind).toBe("started");
  expect(start.mock.calls[0]?.[1]).toEqual([
    {
      ticket: "AGE-342",
      binding: "api",
      triggerId: "trig_manual",
      issueId: ISSUE_ID,
      identifier: "AGE-342",
    },
  ]);
});

test("a workflow with no ticket input is handed triggerId alone", async () => {
  start.mockClear();
  const result = await startRun(factory, "sweep", {}, "trig_sched");

  expect(result.kind).toBe("started");
  expect(start.mock.calls[0]?.[1]).toEqual([
    { olderThanDays: 7, triggerId: "trig_sched" },
  ]);
});
