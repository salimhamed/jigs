import type { PullRequestReview, PullRequestSnapshot } from "../../providers/github.ts";
import type { ApprovalSignal } from "./policy.ts";

/**
 * How the operator's consent reads right now. `stale` is an approval that
 * named an earlier commit — a different thing to tell an operator than a pull
 * request nobody has approved.
 */
export type ApprovalState = "approved" | "changes-requested" | "stale" | "none";

/**
 * Is the operator's consent recorded on the pull request, as this factory
 * asked for it?
 *
 * - `review`: the latest review each person left is the one that counts, and
 *   at least one of them approves this exact commit with none requesting
 *   changes. An approval names a commit, so a push withdraws it.
 * - `label`: the label is on the pull request. It means "merge whenever
 *   ready", so it survives later pushes and jigs never removes it.
 */
export function approvalState(
  snapshot: PullRequestSnapshot,
  approval: ApprovalSignal,
): ApprovalState {
  if (approval.kind === "label") {
    return snapshot.labels.includes(approval.name) ? "approved" : "none";
  }
  const latest = new Map<string, PullRequestReview>();
  for (const review of [...snapshot.reviews].sort(
    (a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id - b.id,
  )) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latest.set(review.user, review);
    }
  }
  const reviews = [...latest.values()];
  if (reviews.some((review) => review.state === "CHANGES_REQUESTED")) return "changes-requested";
  const approved = reviews.filter((review) => review.state === "APPROVED");
  if (approved.some((review) => review.commitSha === snapshot.headSha)) return "approved";
  return approved.length === 0 ? "none" : "stale";
}

/** {@link approvalState} as the single question a merge asks of it. */
export function isApprovalSatisfied(
  snapshot: PullRequestSnapshot,
  approval: ApprovalSignal,
): boolean {
  return approvalState(snapshot, approval) === "approved";
}

// Written for the operator reading a parked pull request: this sentence is
// also the `blocker` line `jigs logs` prints.
function approvalMissing(
  state: ApprovalState,
  approval: ApprovalSignal,
  expectedHeadSha: string,
): string {
  if (state === "changes-requested") return "a review requests changes";
  if (state === "stale") return `the approval does not cover ${expectedHeadSha}`;
  return approval.kind === "label"
    ? `the ${approval.name} label is not on the pull request`
    : "no approving review yet";
}

/** Why a merge did not happen, and whether a later wake could change it. */
export interface MergeRefusal {
  reason: string;
  /**
   * Whether the same head could still merge. A transient refusal is a state
   * jigs is waiting out — a check still running, a merge state GitHub has not
   * finished computing, an approval waiting to be granted again — so the
   * commit stays merge-ready and the next wake asks again. A terminal one is
   * the pull request as it stands refusing the merge, so the commit is stood
   * down until a new commit or a change to the repository moves it.
   */
  transient: boolean;
}

/**
 * Why this pull request cannot merge at `expectedHeadSha`, or `null` when it
 * can. The single verdict behind both the gate, which asks about the head it
 * just read, and the merge step, which asks again about the head it pinned.
 *
 * `mergeable_state` is the authority that will accept or refuse the merge call,
 * and it already folds in conflicts, required checks and required reviews, so
 * jigs re-derives none of that. Anything other than `clean` — `unknown`
 * included, which only means GitHub is still computing it — is "not yet, ask
 * again on the next wake", with `dirty` the exception: a conflicting branch
 * needs a new commit, and no amount of asking makes one.
 *
 * `mergeable_state` is not enough on its own: a repository that requires no
 * checks is `clean` with no build at all, including in the seconds before CI
 * registers, so a label-approved pull request could merge ahead of its own
 * build. `ci` closes that: it is green only when there is at least one check
 * and every one of them passed. The cost is deliberate — jigs never merges a
 * repository with no CI, and such a repository needs `merge.by: "human"`.
 */
export function mergeRefusal(
  snapshot: PullRequestSnapshot,
  expectedHeadSha: string,
  approval: ApprovalSignal,
): MergeRefusal | null {
  if (snapshot.headSha !== expectedHeadSha) {
    return {
      reason: `the head moved from ${expectedHeadSha} to ${snapshot.headSha}`,
      transient: true,
    };
  }
  if (snapshot.state !== "open" || snapshot.merged) {
    return { reason: "the pull request is no longer open", transient: false };
  }
  // Marking a draft ready to review is a webhook of its own, and the head it
  // arrives on is this one.
  if (snapshot.draft) return { reason: "the pull request is a draft", transient: true };
  if (snapshot.mergeState === "dirty") {
    return { reason: "the branch conflicts with its base", transient: false };
  }
  // Approving again is all this takes, and the approval names this same
  // commit, so the wake that carries it is the one that merges.
  const consent = approvalState(snapshot, approval);
  if (consent !== "approved") {
    return { reason: approvalMissing(consent, approval, expectedHeadSha), transient: true };
  }
  if (snapshot.mergeState !== "clean") {
    return { reason: `GitHub reports the merge state as ${snapshot.mergeState}`, transient: true };
  }
  if (snapshot.ci !== "green") {
    return { reason: `CI is ${snapshot.ci}`, transient: true };
  }
  return null;
}

/** May this pull request merge now? {@link mergeRefusal} for why it may not. */
export function isPullRequestMergeReady(
  snapshot: PullRequestSnapshot,
  approval: ApprovalSignal,
): boolean {
  return mergeRefusal(snapshot, snapshot.headSha, approval) === null;
}
