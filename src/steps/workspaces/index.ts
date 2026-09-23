/**
 * Provision a repository worktree outside workflow code.
 *
 * Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.
 *
 * @module steps/workspaces
 * @packageDocumentation
 */

export {
  type ProvisionWorktreeDependencies,
  provisionWorktree,
  type WorktreeRequest,
} from "./provision-worktree.ts";
