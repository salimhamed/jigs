/**
 * Prepare a run-owned worktree for a configured GitHub binding.
 *
 * `provisionWorktree` cuts the run's own branch and working copy from the
 * binding's clone; `provisionPullRequestWorktree` checks out a pull request's
 * head instead. Call their generated `#jigs/steps` wrappers from workflow code so a resumed
 * workflow receives the recorded workspace information. The low-level functions
 * here belong inside a factory-owned `"use step"` implementation. `listBindings` reads
 * the bindings a worktree can be cut from.
 *
 * @module steps/workspaces
 * @packageDocumentation
 */

export { listBindings } from "./list-bindings.ts";
export {
  type PullRequestWorktreeRequest,
  provisionPullRequestWorktree,
  provisionWorktree,
  type WorktreeRequest,
} from "./provision-worktree.ts";
