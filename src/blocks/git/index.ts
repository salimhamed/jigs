/**
 * Read and render bounded descriptions of changes in a Git worktree.
 *
 * @packageDocumentation
 */

export {
  type ChangePatch,
  type ChangeStatus,
  type ChangeSummary,
  type FileChange,
  parseNameStatus,
  parseNumstat,
  renderChangeSummary,
} from "./change.ts";
