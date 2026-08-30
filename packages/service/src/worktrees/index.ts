// The step side of the worktree lifecycle: what the factory's "use step"
// wrappers delegate to. The runtime creates a worktree, registers it, and
// tears it down when the run reaches a terminal state — authors write no
// cleanup, because an author `finally` would fire on every suspension too,
// and a suspended run keeps its worktree.
//
// Everything below reaches node builtins, so this module must only ever be
// imported from inside a step body. `WorktreeRequest` is a type, so a
// workflow-side `import type` of it is erased and stays safe.

import type { WorktreeFacts } from "jigs";
import { provisionRequest } from "./request";
import { registrySql } from "./sql";
import { teardownRun } from "./teardown";

export interface WorktreeRequest {
  binding: string;
  branch: string;
  keep?: boolean;
}

// Named for the run it belongs to, like its teardown counterpart below —
// `provisionWorktree` is already jigs' own git-level primitive, which
// ./request calls underneath this.
export async function provisionRunWorktree(
  request: WorktreeRequest,
  runId: string,
): Promise<WorktreeFacts> {
  return provisionRequest({ ...request, runId });
}

// The per-run half of the teardown matrix, on a jig's own completion path.
// The sweep timer stays the net for runs that never get there.
export async function teardownRunWorktrees(
  runId: string,
  outcome: { merged: boolean },
): Promise<string[]> {
  const sql = registrySql();
  if (sql === null) return [];
  return teardownRun(runId, outcome, { sql });
}
