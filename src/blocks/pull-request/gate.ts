// Determinism rule for this module: the provider fetch lives in
// ../../steps/pull-request/fetch-state.ts, which the factory wraps as a step
// and injects; the generator body only passes memoized snapshots through the
// pure classifier. Nothing is carried between rounds — what jigs has already
// done is written on the pull request itself, as markers, so a snapshot alone
// decides what is still outstanding.

import { createHook } from "workflow";
import type {
  CheckRun,
  PrComment,
  PrRef,
  PrReview,
  PrSnapshot,
  ReviewThread,
} from "../../providers/github.ts";
import { ClaimConflictError } from "../ticket/claim.ts";
import { carriesMarker, commentSource, type MarkerLedger, readLedger } from "./marker.ts";
import { isPullRequestMergeReady } from "./merge-ready.ts";

// The gate's hook token names the pull request, never the run: owning it is
// the exclusivity lock. The ingress has only a webhook payload to go on, so it
// reconstructs the token through prToken below — build and parse cannot drift
// while they share the one constructor.
export const PR_TOKEN_PREFIX = "github:pr:";

export function prToken(pr: PrRef): string {
  return `${PR_TOKEN_PREFIX}${pr.owner}/${pr.repo}#${pr.number}`;
}

type GithubPayload = {
  pull_request?: { number?: unknown };
  // issue_comment fires for issues too; only a PR carries issue.pull_request.
  issue?: { number?: unknown; pull_request?: unknown };
  check_suite?: { pull_requests?: Array<{ number?: unknown }> };
  check_run?: { pull_requests?: Array<{ number?: unknown }> };
  repository?: { name?: unknown; owner?: { login?: unknown } };
};

function prNumber(payload: GithubPayload): number | null {
  const candidates = [
    payload.pull_request?.number,
    payload.issue?.pull_request === undefined ? undefined : payload.issue?.number,
    payload.check_suite?.pull_requests?.[0]?.number,
    payload.check_run?.pull_requests?.[0]?.number,
  ];
  const number = candidates.find((value) => typeof value === "number");
  return number ?? null;
}

// Any GitHub event that names a pull request and a repository is routable:
// pull_request and pull_request_review carry it directly, issue_comment
// carries it only on a PR, and the check events carry it in a list. Everything
// else (ping included) is not.
export function tokenFromGithubPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { repository } = payload as GithubPayload;
  const repo = repository?.name;
  const owner = repository?.owner?.login;
  const number = prNumber(payload as GithubPayload);
  if (number === null || typeof repo !== "string" || typeof owner !== "string") {
    return null;
  }
  return prToken({ owner, repo, number });
}

// Re-exported: a factory's composition names the pull request the gate listens
// on, and this is the subpath it already reaches for the gate itself.
export type { PrRef };

/**
 * What is outstanding on the pull request right now. Every wake describes
 * current state, so the same state yields the same wake until the consumer
 * leaves evidence on the pull request that it is done with it:
 *
 * - `review-comments`: feedback with no answer carrying this scope's marker.
 * - `ci-red`: the current head is red, with no marked stand-down for it.
 * - `merge-ready`: green plus an approval of the current head, not merged,
 *   with no marked stand-down for it.
 * - `closed`: terminal.
 */
export type GateWake =
  | { kind: "merge-ready"; headSha: string }
  // `body` is the summary of the CHANGES_REQUESTED review these threads were
  // submitted with, when they came together. A thread with `origin:
  // "conversation"` is not an inline thread at all: it is a review's body or a
  // pull request conversation comment, carried in the same shape.
  | { kind: "review-comments"; threads: ReviewThread[]; body?: string }
  | {
      kind: "ci-red";
      headSha: string;
      failing: CheckRun[];
      // Who to escalate to when the fix bound runs out: the most recent human
      // reviewer. Only the snapshot knows, so the wake carries it.
      mentionLogin: string | null;
    }
  | { kind: "closed"; merged: boolean };

// A review summary and a conversation comment both arrive without an inline
// anchor. Carrying them as single-comment threads gives the builder one shape
// to answer and the classifier one shape to mark; `origin` is what routes the
// answer back to the conversation.
function conversationThread(rootId: number, body: string, user: string, at: string): ReviewThread {
  return {
    rootId,
    path: "",
    line: null,
    origin: "conversation",
    comments: [
      { id: rootId, rootId, body, user, path: "", line: null, createdAt: at, updatedAt: at },
    ],
  };
}

// A review body is not editable through the reviews API in a way the listing
// reports, so its submission time is its version.
const reviewBodyThread = (review: PrReview): ReviewThread =>
  conversationThread(review.id, review.body, review.user, review.submittedAt);

const commentThread = (comment: PrComment): ReviewThread =>
  conversationThread(comment.id, comment.body, comment.user, comment.updatedAt);

// Every comment body on the pull request, wherever it hangs: the markers in
// them are the whole record of what jigs has done here.
function bodies(snapshot: PrSnapshot): string[] {
  return [
    ...snapshot.reviews.map((review) => review.body),
    ...snapshot.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.body)),
    ...snapshot.conversationComments.map((comment) => comment.body),
  ];
}

/** What this scope has already done here, as the pull request records it. */
export function readPrLedger(snapshot: PrSnapshot, scope: string): MarkerLedger {
  return readLedger(bodies(snapshot), scope);
}

function lastHumanReviewer(snapshot: PrSnapshot): string | null {
  return snapshot.reviews.findLast((review) => !carriesMarker(review.body))?.user ?? null;
}

export interface PrState {
  wakes: GateWake[];
  done: boolean;
  /** Comments on the pull request that any jigs workflow wrote. */
  ownComments: number;
}

/**
 * What this scope still owes the pull request, derived from the snapshot and
 * the markers in it. Pure: two identical snapshots classify identically, and a
 * snapshot whose comments already carry this scope's answers yields nothing.
 */
export function classifyPrState(snapshot: PrSnapshot, scope: string): PrState {
  const ownComments = bodies(snapshot).filter(carriesMarker).length;
  if (snapshot.state === "closed") {
    return { wakes: [{ kind: "closed", merged: snapshot.merged }], done: true, ownComments };
  }
  const ledger = readPrLedger(snapshot, scope);
  const wakes: GateWake[] = [];
  const threads: ReviewThread[] = [];

  const outstanding = (comment: { id: number; updatedAt: string; body: string }): boolean =>
    // jigs' own comment is the last word on something it just answered, and
    // its marker is what says so — the author login cannot, because a factory
    // running on its operator's token posts as the operator.
    comment.body !== "" &&
    !carriesMarker(comment.body) &&
    !ledger.answered.has(commentSource(comment));

  for (const thread of snapshot.reviewThreads) {
    if (thread.comments.some(outstanding)) threads.push(thread);
  }
  for (const comment of snapshot.conversationComments) {
    // Coverage reports, dependabot and release-please all comment here, and a
    // revision round each would burn the budget on nobody's feedback.
    if (comment.userType === "Bot") continue;
    if (outstanding(comment)) threads.push(commentThread(comment));
  }
  // A COMMENTED review is the only review a factory sharing its operator's
  // GitHub identity can leave on its own pull request — GitHub refuses approve
  // and request-changes there — so its body is feedback, not chatter.
  let requestedChanges: string | undefined;
  for (const review of snapshot.reviews) {
    if (review.state !== "COMMENTED" && review.state !== "CHANGES_REQUESTED") continue;
    if (!outstanding({ id: review.id, updatedAt: review.submittedAt, body: review.body })) continue;
    threads.push(reviewBodyThread(review));
    // The summary is repeated on the wake because the revision prompt frames
    // the round around it; it is answered as a thread like the rest.
    if (review.state === "CHANGES_REQUESTED") requestedChanges = review.body;
  }
  if (threads.length > 0) {
    wakes.push({
      kind: "review-comments",
      threads,
      ...(requestedChanges === undefined ? {} : { body: requestedChanges }),
    });
  }

  // A red head jigs has already reported it could not repair stays reported;
  // any other red is outstanding. A red on a commit the branch has moved past
  // is not in the snapshot at all, which is what retires it. A note about a
  // merge on the same commit says nothing about its checks, which is why a
  // status marker names its reason.
  if (snapshot.ci === "red" && !ledger.settled.ci.has(snapshot.headSha)) {
    wakes.push({
      kind: "ci-red",
      headSha: snapshot.headSha,
      failing: snapshot.failingChecks,
      mentionLogin: lastHumanReviewer(snapshot),
    });
  }

  // Feedback first: merging over an unanswered review comment would answer it
  // with a merge.
  if (
    isPullRequestMergeReady(snapshot) &&
    threads.length === 0 &&
    !ledger.settled.merge.has(snapshot.headSha)
  ) {
    wakes.push({ kind: "merge-ready", headSha: snapshot.headSha });
  }

  // `done` is the pull request being closed, and nothing else. An approval
  // does not end the gate: human-merges mode has to keep listening until the
  // pull request actually closes.
  return { wakes, done: false, ownComments };
}

// Declared here rather than written as `typeof fetchPullRequestState`: declaring the
// contract block-side typechecks the step against the block and keeps this
// side free of any value import into steps/.
export type FetchPrState = (pr: PrRef) => Promise<PrSnapshot>;

/** {@link pullRequestGate} with its step already bound. */
export type GateFn = (pr: PrRef, scope: string) => AsyncGenerator<GateWake, void, undefined>;

// One hook per PR, held across the whole review until the PR closes — the
// token is never released mid-review. Holding it is the single-writer rule; a
// workflow that only reads a pull request registers no hook and reads on its
// own schedule. The first round runs before the hook is ever awaited, so a PR
// already approved before the gate started is caught without a webhook.
export async function* pullRequestGate(
  pr: PrRef,
  fetchState: FetchPrState,
  scope: string,
): AsyncGenerator<GateWake, void, undefined> {
  const token = prToken(pr);
  const hook = createHook<unknown>({ token });
  try {
    const conflict = await hook.getConflict();
    if (conflict !== null) {
      throw new ClaimConflictError(token, conflict.runId);
    }
    while (true) {
      const round = classifyPrState(await fetchState(pr), scope);
      console.log(
        `[prGate] ${pr.owner}/${pr.repo}#${pr.number} scope=${scope} wakes=${round.wakes.length} jigs-comments=${round.ownComments}`,
      );
      for (const wake of round.wakes) yield wake;
      if (round.done) return;
      // Suspend until GitHub reports activity on this PR, or the service's
      // nudge sweep resumes it.
      await hook;
    }
  } finally {
    hook.dispose();
  }
}
