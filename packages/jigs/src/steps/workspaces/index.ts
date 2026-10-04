/**
 * Prepare a run-owned worktree for a configured GitHub binding.
 *
 * `provisionWorktree` cuts the run's own branch and working copy from the
 * binding's clone. Call its generated `#jigs/steps` wrapper from workflow code so a resumed
 * workflow receives the recorded workspace information. The low-level function
 * here belongs inside a factory-owned `"use step"` implementation.
 *
 * @module steps/workspaces
 * @packageDocumentation
 */

export {
  provisionWorktree,
  type WorktreeRequest,
} from "./provision-worktree.ts";
