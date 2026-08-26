// Determinism rule for this module: provider fetches live inside "use step";
// the generator body only sequences memoized snapshots through the pure
// classifier, so the cursor replays identically across restarts.

import { createHook } from "workflow";
import { fetchPrSnapshot, type PrSnapshot } from "../providers/github";
import { ClaimConflictError } from "./claim";
import { suspensionMetadata } from "./record";
import { type PrRef, prToken } from "./tokens";

export type GateWake =
  | {
      kind: "approved";
      reviewId: number;
      reviewer: string;
      submittedAt: string;
    }
  | {
      kind: "changes-requested";
      reviewId: number;
      reviewer: string;
      body: string;
      submittedAt: string;
    }
  | { kind: "closed"; merged: boolean };
// AGE-313 extends this union (comments, CI); consumers must default-case unknown kinds.

export interface GateCursor {
  seenReviewIds: number[];
}

export function classifyPrState(
  snapshot: PrSnapshot,
  cursor: GateCursor,
): { wakes: GateWake[]; cursor: GateCursor; done: boolean } {
  const wakes: GateWake[] = [];
  const seen = new Set(cursor.seenReviewIds);
  const seenReviewIds = [...cursor.seenReviewIds];
  for (const review of snapshot.reviews) {
    if (seen.has(review.id)) continue;
    seenReviewIds.push(review.id);
    if (review.state === "APPROVED") {
      wakes.push({
        kind: "approved",
        reviewId: review.id,
        reviewer: review.user,
        submittedAt: review.submittedAt,
      });
    } else if (review.state === "CHANGES_REQUESTED") {
      wakes.push({
        kind: "changes-requested",
        reviewId: review.id,
        reviewer: review.user,
        body: review.body,
        submittedAt: review.submittedAt,
      });
    }
  }
  let done = wakes.some((wake) => wake.kind === "approved");
  if (snapshot.state === "closed") {
    wakes.push({ kind: "closed", merged: snapshot.merged });
    done = true;
  }
  return { wakes, cursor: { seenReviewIds }, done };
}

// One hook per PR, held across the whole review — the token is never
// released mid-review. The satisfier re-check lives inside the iterator:
// consumers only ever see satisfied wakes, and an unsatisfied wake
// re-suspends without burning an agent turn. The initial fetch catches a PR
// already approved before the gate started, without needing a webhook.
export async function* pullRequestGate(
  pr: PrRef,
): AsyncGenerator<GateWake, void, undefined> {
  const token = prToken(pr);
  const hook = createHook<unknown>({
    token,
    metadata: suspensionMetadata({
      key: `pr-gate:${pr.owner}/${pr.repo}#${pr.number}`,
      reason: "awaiting pull request review",
      payload: pr,
      satisfiedBy: token,
    }),
  });
  try {
    const conflict = await hook.getConflict();
    if (conflict !== null) {
      throw new ClaimConflictError(token, conflict.runId);
    }
    let cursor: GateCursor = { seenReviewIds: [] };
    let result = classifyPrState(await fetchPrState(pr), cursor);
    cursor = result.cursor;
    yield* result.wakes;
    if (result.done) return;
    for await (const _hint of hook) {
      result = classifyPrState(await fetchPrState(pr), cursor);
      cursor = result.cursor;
      yield* result.wakes;
      if (result.done) return;
    }
  } finally {
    hook.dispose();
  }
}

async function fetchPrState(pr: PrRef): Promise<PrSnapshot> {
  "use step";
  const snapshot = await fetchPrSnapshot(pr);
  console.log(
    `[prGate] fetched ${pr.owner}/${pr.repo}#${pr.number} state=${snapshot.state} merged=${snapshot.merged} reviews=${snapshot.reviews.length}`,
  );
  return snapshot;
}
