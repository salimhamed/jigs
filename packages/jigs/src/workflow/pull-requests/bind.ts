import type { commentOnPullRequest } from "../../steps/pull-requests/pr.ts";
import { type PostPullRequestNoteOptions, postPullRequestNote } from "./answers.ts";
import type { FetchPrState, PullRequestReadOptions, PullRequestRef } from "./pull-request.ts";
import { watchPullRequest } from "./watch.ts";

/**
 * The factory's `"use step"` wrappers the pull request routines run.
 *
 * @group Factory plumbing
 */
export interface PullRequestSteps {
  fetchPullRequestState: FetchPrState;
  commentOnPullRequest: typeof commentOnPullRequest;
}

type StepFields = keyof PullRequestSteps;

/**
 * Connect the pull request routines to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindPullRequestSteps(steps: PullRequestSteps) {
  return {
    watchPullRequest: (pr: PullRequestRef, options?: PullRequestReadOptions) =>
      watchPullRequest(pr, steps.fetchPullRequestState, options),
    postPullRequestNote: (options: Omit<PostPullRequestNoteOptions, StepFields>) =>
      postPullRequestNote({ ...options, ...steps }),
  };
}
