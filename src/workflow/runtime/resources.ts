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
 * The kinds jigs records and releases itself, in the order release visits them. Every other kind
 * is recorded only: it stays `live` as history and is never deleted.
 */
export const RELEASABLE_KINDS = [
  "worktree",
  "branch",
  "run-directory",
  "codex-home",
  "pi-home",
] as const;

export type ReleasableKind = (typeof RELEASABLE_KINDS)[number];

export const releasable = (kind: string): kind is ReleasableKind =>
  (RELEASABLE_KINDS as readonly string[]).includes(kind);

/** Whether a resource still holds something release has to deal with. */
export const unreleased = (resource: Pick<ResourceRecord, "kind" | "state">): boolean =>
  releasable(resource.kind) && resource.state !== "released";

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
