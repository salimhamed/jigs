import type { PullRequestRef } from "../pull-requests/pull-request.ts";
import type { Delivery, DeliverySteps } from "./delivery.ts";

/**
 * The parts of a delivery `publishPullRequest` reads.
 *
 * @group Pull request delivery
 */
export type PublishDelivery = Pick<Delivery<unknown>, "worktree">;

/**
 * What `publishPullRequest` needs besides the delivery.
 *
 * @group Pull request delivery
 */
export interface PublishOptions {
  /** The commit to publish. It must be the worktree's HEAD, with nothing uncommitted. */
  commit: string;
  title: string;
  body: string;
  draft?: boolean | undefined;
}

/**
 * Push exactly `commit`, open the pull request with the given title and body, and record it on
 * the run.
 *
 * @remarks
 * No agent runs. Write the title and body first, with `describePullRequest` or by hand, so a
 * failed description leaves no branch on the remote without a pull request.
 *
 * @group Pull request delivery
 */
export async function publishPullRequest(
  { worktree }: PublishDelivery,
  { commit, title, body, draft }: PublishOptions,
  steps: Pick<DeliverySteps, "pushApprovedChange" | "createPullRequest" | "registerResource">,
): Promise<PullRequestRef & { url: string }> {
  await steps.pushApprovedChange(worktree, commit);
  const pr = await steps.createPullRequest({ worktree, title, body, draft });
  await steps.registerResource({
    kind: "pull-request",
    identity: `${pr.owner}/${pr.repo}#${pr.number}`,
    url: pr.url,
  });
  return pr;
}
