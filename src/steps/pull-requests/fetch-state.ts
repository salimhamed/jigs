import type { FetchPrState } from "../../blocks/pull-requests/gate.ts";
import { fetchPrSnapshot, type PullRequestRef } from "../../providers/github.ts";

/** Read the pull request’s checks, reviews, and open review threads. */
export const fetchPullRequestState: FetchPrState = async (pr: PullRequestRef) => {
  const snapshot = await fetchPrSnapshot(pr);
  console.log(
    `[prGate] fetched ${pr.owner}/${pr.repo}#${pr.number} state=${snapshot.state} merged=${snapshot.merged} reviews=${snapshot.reviews.length} threads=${snapshot.reviewThreads.length} ci=${snapshot.ci}`,
  );
  return snapshot;
};
