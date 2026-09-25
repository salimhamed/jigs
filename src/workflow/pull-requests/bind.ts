import type {
  commentOnPullRequest,
  replyToPullRequestReviewThread,
} from "../../steps/pull-requests/pr.ts";
import {
  type PostPullRequestNoteOptions,
  type PostReviewAnswersOptions,
  postPullRequestNote,
  postReviewAnswers,
} from "./answers.ts";
import {
  type FetchPrState,
  type PullRequestGateOptions,
  type PullRequestRef,
  type PullRequestWake,
  pullRequestGate,
} from "./gate.ts";

/**
 * The factory's `"use step"` wrappers the pull request routines run.
 *
 * @group Factory plumbing
 */
export interface PullRequestSteps {
  fetchPullRequestState: FetchPrState;
  commentOnPullRequest: typeof commentOnPullRequest;
  replyToPullRequestReviewThread: typeof replyToPullRequestReviewThread;
}

type StepFields = keyof PullRequestSteps;

/**
 * Connect the pull request routines to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindPullRequestSteps(steps: PullRequestSteps) {
  return {
    pullRequestGate: (
      pr: PullRequestRef,
      options: PullRequestGateOptions,
    ): AsyncIterable<PullRequestWake> => pullRequestGate(pr, steps.fetchPullRequestState, options),
    postReviewAnswers: (options: Omit<PostReviewAnswersOptions, StepFields>) =>
      postReviewAnswers({ ...options, ...steps }),
    postPullRequestNote: (options: Omit<PostPullRequestNoteOptions, StepFields>) =>
      postPullRequestNote({ ...options, ...steps }),
  };
}
