import type { ApprovalSignal } from "../../config/factory-config.ts";
import type { PrReview, PrSnapshot } from "../../providers/github.ts";

// The policy types a factory's configuration and the delivery blocks both
// name. They are declared where the schema that validates them lives, and a
// type import crosses no boundary.
export type { ApprovalSignal, MergePolicy } from "../../config/factory-config.ts";

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
export function isApprovalSatisfied(snapshot: PrSnapshot, approval: ApprovalSignal): boolean {
  if (approval.kind === "label") return snapshot.labels.includes(approval.name);
  const latest = new Map<string, PrReview>();
  for (const review of [...snapshot.reviews].sort(
    (a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id - b.id,
  )) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latest.set(review.user, review);
    }
  }
  const reviews = [...latest.values()];
  return (
    !reviews.some((review) => review.state === "CHANGES_REQUESTED") &&
    reviews.some((review) => review.state === "APPROVED" && review.commitSha === snapshot.headSha)
  );
}

/**
 * May this pull request merge now? The configured approval, plus GitHub's own
 * verdict, plus a green build.
 *
 * `mergeable_state` is the authority that will accept or refuse the merge call,
 * and it already folds in conflicts, required checks and required reviews, so
 * jigs re-derives none of that. Anything other than `clean` — `unknown`
 * included, which only means GitHub is still computing it — is "not yet, ask
 * again on the next wake".
 *
 * It is not enough on its own: a repository that requires no checks is `clean`
 * with no build at all, including in the seconds before CI registers, so a
 * label-approved pull request could merge ahead of its own build. `ci` closes
 * that: it is green only when there is at least one check and every one of them
 * passed. The cost is deliberate — jigs never merges a repository with no CI,
 * and such a repository needs `merge.by: "human"`.
 */
export function isPullRequestMergeReady(snapshot: PrSnapshot, approval: ApprovalSignal): boolean {
  if (snapshot.state !== "open" || snapshot.merged || snapshot.draft) return false;
  if (snapshot.mergeState !== "clean" || snapshot.ci !== "green") return false;
  return isApprovalSatisfied(snapshot, approval);
}
