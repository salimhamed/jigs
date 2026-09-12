import type { PrReview, PrSnapshot } from "../../providers/github.ts";

/** Require passing checks and an effective approval of the current commit. */
export function isPullRequestMergeReady(snapshot: PrSnapshot): boolean {
  if (snapshot.state !== "open" || snapshot.ci !== "green") return false;
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
