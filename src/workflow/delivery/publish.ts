import type { PullRequestRef } from "../pull-requests/pull-request.ts";
import { formats, pullRequestDescription, withFormat } from "./answers.ts";
import { claimKey, type Delivery, type DeliverySteps } from "./delivery.ts";

/**
 * What `publishPullRequest` needs besides the delivery.
 *
 * @group Pull request delivery
 */
export interface PublishOptions {
  /** The commit to publish. It must be the worktree's HEAD, with nothing uncommitted. */
  commit: string;
  /** Turns the writer's description into the pull request body. Defaults to the description. */
  body?: ((description: string) => string) | undefined;
}

/**
 * Describe the change, push exactly `commit`, open the pull request and record it on the run.
 *
 * @remarks
 * The writer describes the diff before anything is pushed, so a failed description leaves no
 * branch on the remote without a pull request. A title that is not one plain line of at most 100
 * characters, or a body with a "Title:" or "Description:" label line, is sent back once with the
 * reasons; a second bad answer throws.
 *
 * @group Pull request delivery
 */
export async function publishPullRequest<W>(
  delivery: Delivery<W>,
  { commit, body = (description) => description }: PublishOptions,
  steps: DeliverySteps,
): Promise<PullRequestRef & { url: string }> {
  claimKey(delivery);
  const { work, worktree, prompts } = delivery;
  const prompt = withFormat(
    prompts.describe({ work, worktree, diff: await steps.readWorktreeDiff(worktree) }),
    formats.describe,
  );
  const described = await (delivery.writer ?? delivery.builder).run({
    output: pullRequestDescription,
    resume: prompt,
    fresh: prompt,
  });

  await steps.pushApprovedChange(worktree, commit);
  const pr = await steps.openPullRequest({
    worktree,
    title: described.title,
    body: body(described.body),
  });
  await steps.registerResource({
    kind: "pull-request",
    identity: `${pr.owner}/${pr.repo}#${pr.number}`,
    url: pr.url,
  });
  return pr;
}
