/**
 * Describe and render committed Git changes for review.
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
