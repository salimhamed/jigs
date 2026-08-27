import type { WorktreeFacts } from "jigs";
import { getWorkflowMetadata } from "workflow";

// The pipeline-facing worktree request. The runtime creates it, registers it,
// and tears it down when the run reaches a terminal state — authors write no
// cleanup, because an author `finally` would fire on every suspension too,
// and a suspended run keeps its worktree.
//
// Workflow-side, so no node builtins and no postgres import at module scope:
// the step shim's dynamic import is what keeps them out of the bundle.

export interface WorktreeRequest {
  binding: string;
  branch: string;
  keep?: boolean;
}

export async function worktree(
  request: WorktreeRequest,
): Promise<WorktreeFacts> {
  return provisionWorktreeStep(request);
}

async function provisionWorktreeStep(
  request: WorktreeRequest,
): Promise<WorktreeFacts> {
  "use step";
  const { provisionRequest } = await import("./request");
  const { workflowRunId } = getWorkflowMetadata();
  return provisionRequest({ ...request, runId: workflowRunId });
}
