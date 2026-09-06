// The step side of the worktree lifecycle: what the factory's "use step"
// wrappers delegate to. The runtime creates a worktree and registers it; the
// pipeline calls teardown as a plain sequential line after a merged
// reviewLoop return — never in a `finally`, which would fire on every
// suspension, and a suspended run keeps its worktree. Every other ending
// leaves the tree for the operator's `jigs sweep`.
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
// `provisionWorktree` is already the binding-level primitive in ./provision,
// which ./request calls underneath this.
export async function provisionRunWorktree(
  request: WorktreeRequest,
  runId: string,
): Promise<WorktreeFacts> {
  return provisionRequest({ ...request, runId });
}

// The per-run half of the teardown matrix, called by the pipeline after a
// merged reviewLoop return. The operator's `jigs sweep` is the net for runs
// that never get there.
export async function teardownRunWorktrees(
  runId: string,
  outcome: { merged: boolean },
): Promise<string[]> {
  const sql = registrySql();
  if (sql === null) return [];
  return teardownRun(runId, outcome, { sql });
}
