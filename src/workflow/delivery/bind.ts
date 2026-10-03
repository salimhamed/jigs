import type { PullRequestRef } from "../pull-requests/pull-request.ts";
import { type BuildAndReviewOptions, buildAndReview } from "./build-and-review.ts";
import type { Delivery, DeliverySteps } from "./delivery.ts";
import { type FollowOptions, followPullRequestToOutcome } from "./follow.ts";
import { type PublishOptions, publishPullRequest } from "./publish.ts";

/**
 * Connect the pull request delivery routines to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindDeliverySteps(steps: DeliverySteps) {
  return {
    buildAndReview: <W>(delivery: Delivery<W>, options: BuildAndReviewOptions) =>
      buildAndReview(delivery, options, steps),
    publishPullRequest: <W>(delivery: Delivery<W>, options: PublishOptions) =>
      publishPullRequest(delivery, options, steps),
    followPullRequestToOutcome: <W>(
      delivery: Delivery<W>,
      pr: PullRequestRef,
      options: FollowOptions,
    ) => followPullRequestToOutcome(delivery, pr, options, steps),
  };
}
