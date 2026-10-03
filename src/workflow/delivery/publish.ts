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
  /**
   * Turns the writer's title and body into the pull request to open, for example to enforce a
   * title convention, add notes to the body, or open a draft. It runs before the push, so throwing
   * from it stops before anything is pushed. Defaults to the description as is.
   */
  pullRequest?:
    | ((described: { title: string; body: string }) => {
        title: string;
        body: string;
        draft?: boolean;
      })
    | undefined;
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
  { commit, pullRequest = (described) => described }: PublishOptions,
  steps: DeliverySteps,
): Promise<PullRequestRef & { url: string }> {
  claimKey(delivery);
  const { work, worktree, prompts } = delivery;
  const prompt = withFormat(
    prompts.describe({ work, worktree, diff: await steps.readWorktreeDiff(worktree) }),
    formats.describe,
  );
  // The prompt carries every fact it needs, so a resumed and a fresh writer are told the same.
  const described = await (delivery.writer ?? delivery.builder).run({
    output: pullRequestDescription,
    resume: prompt,
    fresh: prompt,
  });

  const request = pullRequest(described);
  await steps.pushApprovedChange(worktree, commit);
  const pr = await steps.createPullRequest({ worktree, ...request });
  await steps.registerResource({
    kind: "pull-request",
    identity: `${pr.owner}/${pr.repo}#${pr.number}`,
    url: pr.url,
  });
  return pr;
}
