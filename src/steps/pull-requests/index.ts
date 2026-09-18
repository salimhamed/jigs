export type { GithubRepoRef } from "../../providers/github-webhook.ts";
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
