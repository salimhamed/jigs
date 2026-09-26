/**
 * A durable thing that a run created or otherwise owns a reference to.
 *
 * @group Runtime and resources
 */
export interface RunResource {
  /** The resource category, such as `worktree` or `run-directory`. */
  kind: string;
  /** The stable name that distinguishes this resource from others of the same kind. */
  identity: string;
  /** An absolute URL where a human can inspect the resource. */
  url: string;
}

/**
 * Where a recorded resource stands: `live` until release decides, then `kept` by policy or a
 * safety check, `released`, or `failed` when the release attempt errored and will be retried.
 *
 * @group Runtime and resources
 */
export type ResourceState = "live" | "kept" | "released" | "failed";

/** The states of resources release has not removed, which status and prune show. */
export const UNRELEASED_STATES = [
  "live",
  "kept",
  "failed",
] as const satisfies readonly ResourceState[];

/**
 * One recorded resource and what has happened to it. Records stay after release as history.
 *
 * @group Runtime and resources
 */
export interface ResourceRecord extends RunResource {
  /** The run that owns the resource. */
  runId: string;
  state: ResourceState;
  /** Why the resource is in its state, or null while it is live and untouched. */
  reason: string | null;
  /** When the state last changed, as an ISO timestamp. */
  updatedAt: string;
}
