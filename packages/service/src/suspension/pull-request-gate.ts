// Determinism rule for this module: provider fetches live inside "use step";
// the generator body only sequences memoized snapshots through the pure
// classifier, so the cursor replays identically across restarts.

import { createHook } from "workflow";
import {
  type CheckRun,
  fetchPrSnapshot,
  type PrSnapshot,
  type ReviewThread,
} from "../providers/github";
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
  | { kind: "review-comments"; threads: ReviewThread[] }
  | {
      kind: "ci-red";
      headSha: string;
      failing: CheckRun[];
      // Who to escalate to when the fix bound runs out: the most recent human
      // reviewer. Only the snapshot knows, so the wake carries it.
      mentionLogin: string | null;
    }
  | { kind: "ci-green"; headSha: string }
  | { kind: "closed"; merged: boolean };

export interface GateCursor {
  seenReviewIds: number[];
  seenCommentIds: number[];
  ci: { headSha: string; state: "unknown" | "red" | "green" };
}

export const emptyGateCursor = (): GateCursor => ({
  seenReviewIds: [],
  seenCommentIds: [],
  ci: { headSha: "", state: "unknown" },
});

function lastHumanReviewer(snapshot: PrSnapshot): string | null {
  for (let i = snapshot.reviews.length - 1; i >= 0; i -= 1) {
    const review = snapshot.reviews[i];
    if (review !== undefined && review.user !== snapshot.viewer) {
      return review.user;
    }
  }
  return null;
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

  const seenComments = new Set(cursor.seenCommentIds);
  const seenCommentIds = [...cursor.seenCommentIds];
  const threads: ReviewThread[] = [];
  for (const thread of snapshot.reviewThreads) {
    let unseen = false;
    for (const comment of thread.comments) {
      if (seenComments.has(comment.id)) continue;
      seenComments.add(comment.id);
      seenCommentIds.push(comment.id);
      unseen = true;
    }
    // The viewer guard: jigs' own reply is the last word on a thread it just
    // answered, and must not wake the loop back into it.
    const last = thread.comments.at(-1);
    if (unseen && last !== undefined && last.user !== snapshot.viewer) {
      threads.push(thread);
    }
  }
  if (threads.length > 0) wakes.push({ kind: "review-comments", threads });

  // The cursor's CI state records what the consumer was last told, so a red
  // yields once per head and a green only as a recovery from red — which is
  // what resets the consecutive-red count. Pending says nothing at all.
  let ci = cursor.ci;
  if (
    snapshot.ci === "red" &&
    (ci.headSha !== snapshot.headSha || ci.state !== "red")
  ) {
    wakes.push({
      kind: "ci-red",
      headSha: snapshot.headSha,
      failing: snapshot.failingChecks,
      mentionLogin: lastHumanReviewer(snapshot),
    });
    ci = { headSha: snapshot.headSha, state: "red" };
  } else if (snapshot.ci === "green" && ci.state === "red") {
    wakes.push({ kind: "ci-green", headSha: snapshot.headSha });
    ci = { headSha: snapshot.headSha, state: "green" };
  }

  // `done` is the PR being closed, and nothing else. An approval no longer
  // ends the gate: human-merges mode has to keep listening until the PR
  // actually closes, so ending the review is the consumer's policy call.
  const done = snapshot.state === "closed";
  if (done) wakes.push({ kind: "closed", merged: snapshot.merged });
  return { wakes, cursor: { seenReviewIds, seenCommentIds, ci }, done };
}

// One hook per PR, held across the whole review until the PR closes — the
// token is never released mid-review. The satisfier re-check lives inside the
// iterator:
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
    let cursor: GateCursor = emptyGateCursor();
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
    `[prGate] fetched ${pr.owner}/${pr.repo}#${pr.number} state=${snapshot.state} merged=${snapshot.merged} reviews=${snapshot.reviews.length} threads=${snapshot.reviewThreads.length} ci=${snapshot.ci}`,
  );
  return snapshot;
}
