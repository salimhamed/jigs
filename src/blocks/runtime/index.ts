/**
 * Compose run resource registration and release policy inside a workflow.
 *
 * @packageDocumentation
 */

export { unreachable } from "../unreachable.ts";
export type { CleanupProgress, CleanupView } from "./cleanup.ts";
export {
  bindReleaseSteps,
  type ReleasePolicy,
  type ReleaseReport,
  type ReleaseSteps,
  release,
} from "./release.ts";
export type { RunResource } from "./resources.ts";
