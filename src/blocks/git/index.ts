/**
 * Describe and render committed Git changes for review.
 *
 * @module blocks/git
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
