// Determinism rule for this module: the provider fetch lives in
// ../../steps/pull-request/fetch-state.ts, which the factory wraps as a step
// and injects; the generator body only sequences memoized snapshots through
// the pure classifier, so the cursor replays identically across restarts. The
// acks the consumer hands back are memoized step results too (the ids GitHub
// gave its replies), so they replay with it.

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

export type GateWake =
  | { kind: "merge-ready"; headSha: string }
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
  // submitted with, when they came together. A thread with `origin:
  // "conversation"` is not an inline thread at all: it is a COMMENTED review's
  // body or a pull request conversation comment, carried in the same shape.
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
  // `${id}@${updatedAt}`, not a bare id. A conversation comment has no thread
  // to reply into, so editing one is how a reviewer adds to it, and the edit
  // has to read as new. An inline comment gets a reply instead, and stays
  // keyed by id alone.
  seenConversationComments?: string[];
  // Review-thread replies jigs posted itself. Author identity cannot stand in
  // for this: a factory running on its operator's own token has the operator
  // as `snapshot.viewer`, so filtering by viewer swallows the very review
  // comments the loop exists to answer — the same collision haltForHuman avoids
  // by id on the Linear side.
  selfCommentIds: number[];
  // Conversation comments jigs posted itself — its answers, its summaries and
  // its stand-down notes. Kept apart from `selfCommentIds` because GitHub
  // numbers issue comments and review comments in different spaces.
  selfConversationCommentIds?: number[];
  lastRedSha: string | null;
  lastMergeReadySha?: string | null;
}

/** What the consumer hands back through `next()` after posting its replies. */
export interface GateAck {
  selfCommentIds: number[];
  selfConversationCommentIds?: number[];
}

// A review summary and a conversation comment both arrive without an inline
// anchor. Carrying them as single-comment threads gives the builder one shape
// to answer and the cursor one shape to filter; `origin` is what routes the
// answer back to the conversation.
function conversationThread(
  rootId: number,
  body: string,
  user: string,
  createdAt: string,
): ReviewThread {
  return {
    rootId,
    path: "",
    line: null,
    origin: "conversation",
    comments: [{ id: rootId, rootId, body, user, path: "", line: null, createdAt }],
  };
}

const reviewBodyThread = (review: PrReview): ReviewThread =>
  conversationThread(review.id, review.body, review.user, review.submittedAt);

const commentThread = (comment: PrComment): ReviewThread =>
  conversationThread(comment.id, comment.body, comment.user, comment.createdAt);

function lastHumanReviewer(snapshot: PrSnapshot): string | null {
  return snapshot.reviews.findLast((review) => review.user !== snapshot.viewer)?.user ?? null;
}

export function classifyPrState(
  snapshot: PrSnapshot,
  cursor: GateCursor,
): {
  wakes: GateWake[];
  cursor: GateCursor;
  done: boolean;
  skippedSelfThreads: number;
} {
  if (snapshot.state === "closed") {
    return {
      wakes: [{ kind: "closed", merged: snapshot.merged }],
      cursor,
      done: true,
      skippedSelfThreads: 0,
    };
  }
  const wakes: GateWake[] = [];
  // The self guard: jigs' own comment is the last word on something it just
  // answered, and must not wake the loop back into it. Identified by the ids
  // the loop posted, so a human sharing the token's identity still wakes it.
  let skippedSelfThreads = 0;
  const seenReviewIds = new Set(cursor.seenReviewIds);
  // A COMMENTED review is the only review a factory sharing its operator's
  // GitHub identity can leave on its own pull request — GitHub refuses approve
  // and request-changes there — so its body is feedback, not chatter.
  const reviewBodies: ReviewThread[] = [];
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
    } else if (review.state === "COMMENTED" && review.body !== "") {
      reviewBodies.push(reviewBodyThread(review));
    }
  }

  const seenComments = new Set(cursor.seenCommentIds);
  const selfComments = new Set(cursor.selfCommentIds);
  const threads: ReviewThread[] = [];
  for (const thread of snapshot.reviewThreads) {
    let human = false;
    let ours = 0;
    for (const comment of thread.comments) {
      if (seenComments.has(comment.id)) continue;
      seenComments.add(comment.id);
      if (selfComments.has(comment.id)) ours += 1;
      else human = true;
    }
    if (human) threads.push(thread);
    else if (ours > 0) skippedSelfThreads += 1;
  }

  const seenConversation = new Set(cursor.seenConversationComments ?? []);
  const selfConversation = new Set(cursor.selfConversationCommentIds ?? []);
  for (const comment of snapshot.conversationComments) {
    const version = `${comment.id}@${comment.updatedAt}`;
    if (seenConversation.has(version)) continue;
    seenConversation.add(version);
    // Coverage reports, dependabot and release-please all comment here, and a
    // revision round each would burn the budget on nobody's feedback.
    if (comment.userType === "Bot" || comment.body === "") continue;
    // An edit re-versions a comment jigs wrote too, so the id check comes
    // second and still wins.
    if (selfConversation.has(comment.id)) skippedSelfThreads += 1;
    else threads.push(commentThread(comment));
  }
  threads.push(...reviewBodies);
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
      ...(requested?.kind === "changes-requested" ? { body: requested.body } : {}),
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
  const done = false;
  const ready =
    isPullRequestMergeReady(snapshot) &&
    !wakes.some((wake) => wake.kind === "review-comments" || wake.kind === "changes-requested");
  const lastMergeReadySha = ready ? snapshot.headSha : null;
  if (ready && cursor.lastMergeReadySha !== snapshot.headSha) {
    wakes.push({ kind: "merge-ready", headSha: snapshot.headSha });
  }
  return {
    wakes,
    cursor: {
      seenReviewIds: [...seenReviewIds],
      seenCommentIds: [...seenComments],
      seenConversationComments: [...seenConversation],
      selfCommentIds: [...selfComments],
      selfConversationCommentIds: [...selfConversation],
      lastRedSha,
      lastMergeReadySha,
    },
    done,
    skippedSelfThreads,
  };
}

// Declared here rather than written as `typeof fetchPullRequestState`: declaring the
// contract block-side typechecks the step against the block and keeps this
// side free of any value import into steps/.
export type FetchPrState = (pr: PrRef) => Promise<PrSnapshot>;

/** {@link pullRequestGate} with its step already bound. */
export type GateFn = (pr: PrRef) => AsyncGenerator<GateWake, void, GateAck | undefined>;

// One hook per PR, held across the whole review until the PR closes — the
// token is never released mid-review. The satisfier re-check lives inside the
// iterator: consumers only ever see satisfied wakes, and an unsatisfied wake
// re-suspends without burning an agent turn. The first round runs before the
// hook is ever awaited, so a PR already approved before the gate started is
// caught without needing a webhook.
export async function* pullRequestGate(
  pr: PrRef,
  fetchState: FetchPrState,
): AsyncGenerator<GateWake, void, GateAck | undefined> {
  const token = prToken(pr);
  const hook = createHook<unknown>({ token });
  try {
    const conflict = await hook.getConflict();
    if (conflict !== null) {
      throw new ClaimConflictError(token, conflict.runId);
    }
    let cursor: GateCursor = {
      seenReviewIds: [],
      seenCommentIds: [],
      seenConversationComments: [],
      selfCommentIds: [],
      selfConversationCommentIds: [],
      lastRedSha: null,
    };
    while (true) {
      const round = classifyPrState(await fetchState(pr), cursor);
      if (round.skippedSelfThreads > 0) {
        console.log(
          `[prGate] ${pr.owner}/${pr.repo}#${pr.number} skipped ${round.skippedSelfThreads} comment(s) of jigs' own`,
        );
      }
      cursor = round.cursor;
      for (const wake of round.wakes) {
        const ack = yield wake;
        // An ack arrives between wakes, so it folds into the cursor this
        // round produced, never the one the round was classified against.
        if (ack !== undefined) {
          cursor = {
            ...cursor,
            selfCommentIds: [...new Set([...cursor.selfCommentIds, ...ack.selfCommentIds])],
            selfConversationCommentIds: [
              ...new Set([
                ...(cursor.selfConversationCommentIds ?? []),
                ...(ack.selfConversationCommentIds ?? []),
              ]),
            ],
          };
        }
      }
      if (round.done) return;
      // Suspend until GitHub reports activity on this PR.
      await hook;
    }
  } finally {
    hook.dispose();
  }
}
