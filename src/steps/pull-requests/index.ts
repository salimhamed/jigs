/**
 * Read and update GitHub pull requests outside workflow code.
 *
 * Wrap steps in a factory-owned `"use step"` file. Never call them directly from a workflow.
 *
 * @packageDocumentation
 */

export type { GitHubRepoRef } from "../../providers/github-webhook.ts";
export { fetchPullRequestState } from "./fetch-state.ts";
export {
  commentOnPullRequest,
  type MergeOutcome,
  markPullRequestReady,
  mergePullRequest,
  type OpenedPullRequest,
  openPullRequest,
  replyToPullRequestReviewThread,
  resolveMergePolicy,
  resolveRepository,
  reviewPullRequest,
} from "./pr.ts";
