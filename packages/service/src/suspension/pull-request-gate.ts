// Determinism rule for this module: the provider fetch lives in fetchPrState,
// which the factory wraps as a step and injects; the generator body only
// sequences memoized snapshots through the pure classifier, so the cursor
// replays identically across restarts.

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
  // `body` is the summary of the CHANGES_REQUESTED review these threads were
  // submitted with, when they came together.
  | { kind: "review-comments"; threads: ReviewThread[]; body?: string }
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
  lastRedSha: string | null;
}

export const emptyGateCursor = (): GateCursor => ({
  seenReviewIds: [],
  seenCommentIds: [],
  lastRedSha: null,
});

function lastHumanReviewer(snapshot: PrSnapshot): string | null {
  return (
    snapshot.reviews.findLast((review) => review.user !== snapshot.viewer)
      ?.user ?? null
  );
}

export function classifyPrState(
  snapshot: PrSnapshot,
  cursor: GateCursor,
): { wakes: GateWake[]; cursor: GateCursor; done: boolean } {
  const wakes: GateWake[] = [];
  const seenReviewIds = new Set(cursor.seenReviewIds);
  for (const review of snapshot.reviews) {
    if (seenReviewIds.has(review.id)) continue;
    seenReviewIds.add(review.id);
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
  const threads: ReviewThread[] = [];
  for (const thread of snapshot.reviewThreads) {
    let unseen = false;
    for (const comment of thread.comments) {
      if (seenComments.has(comment.id)) continue;
      seenComments.add(comment.id);
      unseen = true;
    }
    // The viewer guard: jigs' own reply is the last word on a thread it just
    // answered, and must not wake the loop back into it.
    const last = thread.comments.at(-1);
    if (unseen && last !== undefined && last.user !== snapshot.viewer) {
      threads.push(thread);
    }
  }
  // A CHANGES_REQUESTED review carrying inline comments is one act by one
  // reviewer, and the ordinary GitHub flow: yielding it twice would burn two
  // builder turns, the first of them answering a summary blind to the very
  // threads it summarises.
  if (threads.length > 0) {
    const at = wakes.findLastIndex((wake) => wake.kind === "changes-requested");
    const requested = at === -1 ? undefined : wakes.splice(at, 1)[0];
    wakes.push({
      kind: "review-comments",
      threads,
      ...(requested?.kind === "changes-requested"
        ? { body: requested.body }
        : {}),
    });
  }

  // The head the consumer was last told is red, so a red yields once per head
  // and a green only as a recovery from one — which is what resets the
  // consecutive-red count. Pending says nothing at all.
  let lastRedSha = cursor.lastRedSha;
  if (snapshot.ci === "red" && lastRedSha !== snapshot.headSha) {
    wakes.push({
      kind: "ci-red",
      headSha: snapshot.headSha,
      failing: snapshot.failingChecks,
      mentionLogin: lastHumanReviewer(snapshot),
    });
    lastRedSha = snapshot.headSha;
  } else if (snapshot.ci === "green" && lastRedSha !== null) {
    wakes.push({ kind: "ci-green", headSha: snapshot.headSha });
    lastRedSha = null;
  }

  // `done` is the PR being closed, and nothing else. An approval no longer
  // ends the gate: human-merges mode has to keep listening until the PR
  // actually closes, so ending the review is the consumer's policy call.
  const done = snapshot.state === "closed";
  if (done) wakes.push({ kind: "closed", merged: snapshot.merged });
  return {
    wakes,
    cursor: {
      seenReviewIds: [...seenReviewIds],
      seenCommentIds: [...seenComments],
      lastRedSha,
    },
    done,
  };
}

/** {@link pullRequestGate} with its step already bound. */
export type GateFn = (pr: PrRef) => AsyncGenerator<GateWake, void, undefined>;

// One hook per PR, held across the whole review until the PR closes — the
// token is never released mid-review. The satisfier re-check lives inside the
// iterator:
// consumers only ever see satisfied wakes, and an unsatisfied wake
// re-suspends without burning an agent turn. The initial fetch catches a PR
// already approved before the gate started, without needing a webhook.
export async function* pullRequestGate(
  pr: PrRef,
  fetchState: typeof fetchPrState,
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
    let result = classifyPrState(await fetchState(pr), cursor);
    cursor = result.cursor;
    yield* result.wakes;
    if (result.done) return;
    for await (const _hint of hook) {
      result = classifyPrState(await fetchState(pr), cursor);
      cursor = result.cursor;
      yield* result.wakes;
      if (result.done) return;
    }
  } finally {
    hook.dispose();
  }
}

export async function fetchPrState(pr: PrRef): Promise<PrSnapshot> {
  const snapshot = await fetchPrSnapshot(pr);
  console.log(
    `[prGate] fetched ${pr.owner}/${pr.repo}#${pr.number} state=${snapshot.state} merged=${snapshot.merged} reviews=${snapshot.reviews.length} threads=${snapshot.reviewThreads.length} ci=${snapshot.ci}`,
  );
  return snapshot;
}
