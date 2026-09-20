/**
 * Describe run-owned resources, inspect cleanup progress and request release from a workflow.
 *
 * @packageDocumentation
 */

/** Fail an exhaustive branch if an unexpected value reaches it at runtime. */
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
