import type { RunSuspension } from "../../run-suspension.ts";

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

/**
 * Everything jigs knows about one run as plain data: the World's status, the resources the run
 * recorded, and the hooks it holds.
 *
 * @group Runtime and resources
 */
export interface RunState {
  runId: string;
  /** The World's run status, or null when the World has no such run. */
  status: string | null;
  /** The workflow ID the World stores for the run, or null when it has no such run. */
  workflowName: string | null;
  /** Every resource the run recorded in this factory, released ones included. */
  resources: ResourceRecord[];
  /** The ticket claim hook the run holds for its whole life, or null. */
  claim: string | null;
  /** The hooks the run is parked on: a pull request watch, a needs-human halt, or another event. */
  waitingOn: RunSuspension[];
}
