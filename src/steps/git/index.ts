/**
 * Low-level Git operations for factory-owned steps. Workflow code normally uses
 * the generated `#jigs/steps` wrappers.
 *
 * Inspect changes before publishing them. `pushApprovedChange` requires the
 * reviewed commit to remain HEAD and the worktree to be clean, including on retries.
 *
 * @module steps/git
 * @packageDocumentation
 */

export {
  branchContains,
  pushApprovedChange,
  pushBranch,
  readBranchState,
  readWorktreeDiff,
} from "./branch.ts";
export { readChange, readPatch } from "./change.ts";
