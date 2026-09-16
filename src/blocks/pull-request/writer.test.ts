import { expect, test, vi } from "vitest";
import { currentRunId, defaultPrScope } from "./writer.ts";

// The compiler stamps a workflow with its durable address; an untransformed
// import (a unit test, a plain call) leaves the bare function name.
const { metadata } = vi.hoisted(() => ({
  metadata: { workflowRunId: "wrun_RUN", workflowName: "workflow//./workflows/ship//shipWorkflow" },
}));

vi.mock("workflow", () => ({ getWorkflowMetadata: () => metadata }));

test("the default scope is the workflow's function name, not where its file sits", () => {
  expect(defaultPrScope("AGE-123")).toBe("shipWorkflow/AGE-123");

  // Moving the file changes the address and must not change the scope, or a
  // parked pull request's markers stop being this workflow's work.
  metadata.workflowName = "workflow//./workflows/delivery/ship//shipWorkflow";
  expect(defaultPrScope("AGE-123")).toBe("shipWorkflow/AGE-123");

  // Renaming the function does change it, exactly as it moves the durable ids.
  metadata.workflowName = "workflow//./workflows/ship//deliverWorkflow";
  expect(defaultPrScope("AGE-123")).toBe("deliverWorkflow/AGE-123");

  metadata.workflowName = "shipWorkflow";
  expect(defaultPrScope("AGE-123")).toBe("shipWorkflow/AGE-123");
});

test("the run id is carried as written", () => {
  expect(currentRunId()).toBe("wrun_RUN");
});
