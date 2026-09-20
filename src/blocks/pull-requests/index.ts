/**
 * Compose pull request creation, review, approval and merge gates inside a workflow.
 *
 * @packageDocumentation
 */

export {
  type PostPullRequestNoteOptions,
  type PostReviewAnswersOptions,
  postPullRequestNote,
  postReviewAnswers,
  renderChecks,
  type ThreadAnswers,
} from "./answers.ts";
export {
  type Attend,
  attend,
  finished,
  listen,
} from "./attend.ts";
export { bindPullRequestSteps } from "./bind.ts";
export {
  classifyPullRequestState,
  PULL_REQUEST_TOKEN_PREFIX,
  type PullRequestGateFn,
  type PullRequestRef,
  type PullRequestState,
  type PullRequestWake,
  pullRequestGate,
  pullRequestToken,
  readPullRequestLedger,
  tokenFromGitHubPayload,
} from "./gate.ts";
export {
  carriesMarker,
  commentSource,
  type MarkerKind,
  type MarkerLedger,
  markBody,
  type PullRequestMarker,
  parseMarkers,
  pullRequestScope,
  readLedger,
  renderMarker,
  type StatusReason,
} from "./marker.ts";
export {
  type ApprovalState,
  approvalState,
  isApprovalSatisfied,
  isPullRequestMergeReady,
  type MergeRefusal,
  mergeRefusal,
} from "./merge-ready.ts";
export {
  type ApprovalSignal,
  approvalSignalSchema,
  type MergePolicy,
  mergePolicySchema,
} from "./policy.ts";
export { currentRunId, defaultPullRequestScope } from "./writer.ts";
