import { readFactoryConfig } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import {
  fetchPrSnapshot,
  type PullRequestRef,
  type PullRequestSnapshot,
} from "../../providers/github.ts";
import type { FetchPrState } from "../../workflow/pull-requests/gate.ts";
import { approvalState } from "../../workflow/pull-requests/merge-ready.ts";

/** The pull request with the operator's consent read against the factory's `github.mergeApproval`. */
export async function readPullRequestSnapshot(pr: PullRequestRef): Promise<PullRequestSnapshot> {
  const facts = await fetchPrSnapshot(pr);
  const signal = readFactoryConfig(factoryRoot()).github.mergeApproval;
  return { ...facts, approval: { signal, state: approvalState(facts, signal) } };
}

/** Read the pull request’s checks, reviews, open review threads and approval. */
export const fetchPullRequestState: FetchPrState = async (pr: PullRequestRef) => {
  const snapshot = await readPullRequestSnapshot(pr);
  console.log(
    `[prGate] fetched ${pr.owner}/${pr.repo}#${pr.number} state=${snapshot.state} merged=${snapshot.merged} reviews=${snapshot.reviews.length} threads=${snapshot.reviewThreads.length} ci=${snapshot.ci} approval=${snapshot.approval.state}`,
  );
  return snapshot;
};
