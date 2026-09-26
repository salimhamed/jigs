import type { StepMetadata, WorkflowMetadata } from "workflow";

/**
 * The run a step belongs to: `getWorkflowMetadata()` inside the step.
 *
 * @group Runtime metadata
 */
export type RunMetadata = Pick<WorkflowMetadata, "workflowRunId">;
export type NamedRunMetadata = Pick<WorkflowMetadata, "workflowRunId" | "workflowName">;

/**
 * The run and the step a posting belongs to: `{ ...getWorkflowMetadata(), stepId: getStepMetadata().stepId }`
 * inside the step. The step id is the same on every retry of that step.
 *
 * @group Runtime metadata
 */
export type StepRunMetadata = NamedRunMetadata & Pick<StepMetadata, "stepId">;

// What a step can tell a human about the run it is inside. The Workflow SDK's
// metadata carries the run id and the workflow name; the dashboard link is
// jigs', and only the service process knows it — the port the service was
// started on, which is also what `jigs status <run-id>` prints.

/**
 * The run's page on the dashboard this service hosts, or undefined when the
 * service was started without one. Never a standalone `workflow web` URL: run
 * against a live World it opens a second queue worker and steals the jobs the
 * run is waiting on.
 *
 * @group Advanced run context
 */
export function dashboardRunUrl(runId: string): string | undefined {
  const port = process.env.JIGS_DASHBOARD_PORT;
  if (port === undefined || port === "") return undefined;
  return `http://localhost:${port}/run/${runId}`;
}
