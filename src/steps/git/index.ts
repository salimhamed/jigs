/**
 * Inspect committed changes and push branches in a Git worktree.
 *
 * Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.
 *
 * @module steps/git
 * @packageDocumentation
 */

export {
  pushApprovedChange,
  pushBranch,
  readBranchState,
  readWorktreeDiff,
} from "./branch.ts";
export { readChange, readPatch } from "./change.ts";
