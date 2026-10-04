/**
 * Low-level GitHub operations for factory-owned steps. Call their durable
 * `#jigs/steps` wrappers from workflow code.
 *
 * Watch changes with `watchPullRequest` from `#jigs/routines`, and post updates
 * with `postPullRequestNote`. `callGitHub` reaches any other REST endpoint from a factory's own `"use step"` function.
 * See [Waiting and external events](https://salimhamed.github.io/jigs/guide/waiting-and-events).
 *
 * @module steps/pull-requests
 * @packageDocumentation
 */

export { GitHubApiError } from "../../providers/github-http.ts";
export { callGitHub } from "./call.ts";
export { fetchPullRequestState } from "./fetch-state.ts";
export {
  commentOnPullRequest,
  createPullRequest,
  type MergeOutcome,
  markPullRequestReady,
  mergePullRequest,
  type OpenedPullRequest,
  replyToPullRequestReviewThread,
  reviewPullRequest,
} from "./pr.ts";
