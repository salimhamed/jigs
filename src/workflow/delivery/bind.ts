import type { PullRequestRef } from "../pull-requests/pull-request.ts";
import {
  type BuildAndReviewOptions,
  type BuildDelivery,
  buildAndReview,
} from "./build-and-review.ts";
import type { DeliverySteps } from "./delivery.ts";
import { type DescribeDelivery, type DescribeOptions, describePullRequest } from "./describe.ts";
import { type FollowDelivery, type FollowOptions, followPullRequestToOutcome } from "./follow.ts";
import { type PublishDelivery, type PublishOptions, publishPullRequest } from "./publish.ts";

/**
 * Connect the pull request delivery routines to the factory's durable steps.
 *
 * @group Factory plumbing
 */
export function bindDeliverySteps(steps: DeliverySteps) {
  return {
    buildAndReview: <W>(delivery: BuildDelivery<W>, options: BuildAndReviewOptions) =>
      buildAndReview(delivery, options, steps),
    describePullRequest: <W>(delivery: DescribeDelivery<W>, options: DescribeOptions = {}) =>
      describePullRequest(delivery, options, steps),
    publishPullRequest: (delivery: PublishDelivery, options: PublishOptions) =>
      publishPullRequest(delivery, options, steps),
    followPullRequestToOutcome: <W>(
      delivery: FollowDelivery<W>,
      pr: PullRequestRef,
      options: FollowOptions,
    ) => followPullRequestToOutcome(delivery, pr, options, steps),
  };
}
