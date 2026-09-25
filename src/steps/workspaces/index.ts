/**
 * Prepare a run-owned worktree for a configured GitHub binding.
 *
 * `provisionWorktree` creates or reuses the run's working copy from the binding's
 * clone. Call its generated `#jigs/steps` wrapper from workflow code so a resumed
 * workflow receives the recorded workspace information. The low-level function
 * here belongs inside a factory-owned `"use step"` implementation.
 *
 * @module steps/workspaces
 * @packageDocumentation
 */

export {
  type ProvisionWorktreeDependencies,
  provisionWorktree,
  type WorktreeRequest,
} from "./provision-worktree.ts";
