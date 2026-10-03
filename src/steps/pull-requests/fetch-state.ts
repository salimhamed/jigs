import { readFactoryConfig } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import {
  fetchPrSnapshot,
  type PullRequestRef,
  type PullRequestSnapshot,
} from "../../providers/github.ts";
import { appBotFor, githubAuthFor } from "../../providers/github-auth.ts";
import { approvalState } from "../../workflow/pull-requests/merge-ready.ts";
import type {
  FetchPrState,
  PullRequestReadOptions,
} from "../../workflow/pull-requests/pull-request.ts";

/**
 * The pull request with the operator's consent read against the factory's `github.mergeApproval`,
 * covering the commits the workflow asks for.
 */
export async function readPullRequestSnapshot(
  pr: PullRequestRef,
  { approvalCovers = "latest-commit" }: PullRequestReadOptions = {},
): Promise<PullRequestSnapshot> {
  const facts = await fetchPrSnapshot(pr);
  const signal = readFactoryConfig(factoryRoot()).github.mergeApproval;
  const state = approvalState(facts, signal, { covers: approvalCovers });
  const auth = githubAuthFor(pr.owner);
  const appBot =
    auth.identity.mode === "app"
      ? (await appBotFor(auth.identity, () => auth.bearer())).login
      : undefined;
  return { ...facts, ...(appBot === undefined ? {} : { appBot }), approval: { signal, state } };
}

/**
 * Read the pull request’s checks, reviews, open review threads and approval.
 *
 * @group Read
 */
export const fetchPullRequestState: FetchPrState = async (pr, options) => {
  const snapshot = await readPullRequestSnapshot(pr, options);
  console.log(
    `[pullRequest] fetched ${pr.owner}/${pr.repo}#${pr.number} state=${snapshot.state} merged=${snapshot.merged} reviews=${snapshot.reviews.length} threads=${snapshot.reviewThreads.length} ci=${snapshot.ci} approval=${snapshot.approval.state}`,
  );
  return snapshot;
};
