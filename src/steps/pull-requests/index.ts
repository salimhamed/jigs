/**
 * Low-level GitHub operations for factory-owned steps. Call their durable
 * `#jigs/steps` wrappers from workflow code.
 *
 * Watching a pull request over time uses a routine such as `watchPullRequest` or
 * `pullRequestGate`. See [Waiting and external events](https://salimhamed.github.io/jigs/guide/waiting-and-events).
 *
 * @module steps/pull-requests
 * @packageDocumentation
 */

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
