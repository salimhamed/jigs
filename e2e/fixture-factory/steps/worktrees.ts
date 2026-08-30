// The factory half of a jigs step: @jigs/service exports the plain
// implementation and the `"use step"` wrapper lives here, so the id the SDK
// derives is `step//./steps/worktrees//worktree` — a path in this repo, with
// no package version in it. A real factory gets this file from `jigs init`;
// the fixture keeps one wrapper, which is all the id list needs to stay honest.
//
// The implementation is imported inside the body, never at module scope: this
// file is reached from the workflow side (the pipeline calls the wrapper), the
// directive transform strips the body, and the implementation reaches node
// builtins the workflow bundle must never see.

import type { WorktreeRequest } from "@jigs/service/worktrees";
import type { WorktreeFacts } from "jigs";
import { getWorkflowMetadata } from "workflow";

export async function worktree(
  request: WorktreeRequest,
): Promise<WorktreeFacts> {
  "use step";
  const { provisionRunWorktree } = await import("@jigs/service/worktrees");
  const { workflowRunId } = getWorkflowMetadata();
  return provisionRunWorktree(request, workflowRunId);
}
