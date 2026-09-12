// The gate's one provider call, wrapped as a step by the factory so every
// snapshot the generator classifies is a memoized step result.

import type { FetchPrState } from "../../blocks/pull-request/gate.ts";
import { fetchPrSnapshot, type PrRef } from "../../providers/github.ts";

/** Read the pull request’s checks, reviews, and open review threads. */
export const fetchPullRequestState: FetchPrState = async (pr: PrRef) => {
  const snapshot = await fetchPrSnapshot(pr);
  console.log(
    `[prGate] fetched ${pr.owner}/${pr.repo}#${pr.number} state=${snapshot.state} merged=${snapshot.merged} reviews=${snapshot.reviews.length} threads=${snapshot.reviewThreads.length} ci=${snapshot.ci}`,
  );
  return snapshot;
};
