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
  type BranchContains,
  type FetchPrState,
  type PullRequestGateOptions,
  type PullRequestRef,
  type PullRequestWake,
  pullRequestGate,
  type ReadLocalHead,
} from "./gate.ts";

/**
 * The factory's `"use step"` wrappers the pull request routines run.
 *
 * @group Factory plumbing
 */
export interface PullRequestSteps {
  fetchPullRequestState: FetchPrState;
  readBranchState: ReadLocalHead;
  branchContains: BranchContains;
  commentOnPullRequest: typeof commentOnPullRequest;
  replyToPullRequestReviewThread: typeof replyToPullRequestReviewThread;
}

import { watchPullRequest } from "./watch.ts";

type StepFields = keyof PullRequestSteps;

/**
 * Connect the pull request routines to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindPullRequestSteps(steps: PullRequestSteps) {
  return {
    watchPullRequest: (pr: PullRequestRef) => watchPullRequest(pr, steps.fetchPullRequestState),
    pullRequestGate: (
      pr: PullRequestRef,
      options: PullRequestGateOptions,
    ): AsyncIterable<PullRequestWake> =>
      pullRequestGate(
        pr,
        {
          fetchState: steps.fetchPullRequestState,
          readLocalHead: steps.readBranchState,
          branchContains: steps.branchContains,
        },
        options,
      ),
    postReviewAnswers: (options: Omit<PostReviewAnswersOptions, StepFields>) =>
      postReviewAnswers({ ...options, ...steps }),
    postPullRequestNote: (options: Omit<PostPullRequestNoteOptions, StepFields>) =>
      postPullRequestNote({ ...options, ...steps }),
  };
}
