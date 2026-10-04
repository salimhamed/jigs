import { currentFactoryContext } from "../../config/factory-context.ts";
import { JigsError } from "../../errors.ts";
import {
  fetchPrSnapshot,
  type PullRequestRef,
  type PullRequestSnapshot,
} from "../../providers/github.ts";
import { appBotFor, type GithubAuth, githubAuthFor } from "../../providers/github-auth.ts";
import type { ResolvedAppIdentity } from "../../workflow/factory-schema.ts";
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
  const signal = currentFactoryContext().config.github.mergeApproval;
  const state = approvalState(facts, signal, { covers: approvalCovers });
  const snapshot: PullRequestSnapshot = { ...facts, approval: { signal, state } };
  const auth = githubAuthFor(pr.owner);
  if (auth.identity.mode === "app") snapshot.appBot = await lookUpAppBot(auth.identity, auth);
  return snapshot;
}

async function lookUpAppBot(identity: ResolvedAppIdentity, auth: GithubAuth): Promise<string> {
  try {
    return (await appBotFor(identity, () => auth.bearer())).login;
  } catch (error) {
    throw new JigsError(
      `could not look up the bot account of GitHub App ${identity.appId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
