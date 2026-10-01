/**
 * Low-level GitHub operations for factory-owned steps. Call their durable
 * `#jigs/steps` wrappers from workflow code.
 *
 * Watch changes with `watchPullRequest` from `#jigs/routines`, and reply or post
 * updates with `postReviewAnswers` and `postPullRequestNote`. `callGitHub`
 * reaches any other REST endpoint from a factory's own `"use step"` function.
 * See [Waiting and external events](https://salimhamed.github.io/jigs/guide/waiting-and-events).
 *
 * @module steps/pull-requests
 * @packageDocumentation
 */

export { GitHubApiError } from "../../providers/github-api.ts";
export { callGitHub } from "./call.ts";
export { fetchPullRequestState } from "./fetch-state.ts";
export {
  commentOnPullRequest,
  type MergeOutcome,
  markPullRequestReady,
  mergePullRequest,
  type OpenedPullRequest,
  openPullRequest,
  replyToPullRequestReviewThread,
  reviewPullRequest,
} from "./pr.ts";
