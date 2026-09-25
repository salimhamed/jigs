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
import type { FetchPrState, PullRequestRef } from "./pull-request.ts";
import { watchPullRequest } from "./watch.ts";

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
    watchPullRequest: (pr: PullRequestRef) => watchPullRequest(pr, steps.fetchPullRequestState),
    postReviewAnswers: (options: Omit<PostReviewAnswersOptions, StepFields>) =>
      postReviewAnswers({ ...options, ...steps }),
    postPullRequestNote: (options: Omit<PostPullRequestNoteOptions, StepFields>) =>
      postPullRequestNote({ ...options, ...steps }),
  };
}
