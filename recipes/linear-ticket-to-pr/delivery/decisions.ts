// The Jev decisions this recipe makes, each a question plus the state it is asked about.

import { choice } from "@jigs-ai/jigs";

/** What changed on the pull request since the builder last assessed it. */
export interface PullRequestWakeState {
  ci: "red" | "green" | "pending" | "none";
  failingChecks: { name: string }[];
  approval: "approved" | "changes-requested" | "stale" | "none";
  mergeState: string;
  newComments: { user: string; body: string; path?: string }[];
  newReviews: { user: string; state: string; body: string }[];
}

/** Asked before waking the builder on a changed pull request. */
export const pullRequestWake = choice(
  "A pull request an AI builder opened has changed. Given its CI, approval, merge state and the comments and reviews added since the builder last looked, what does it need now?",
  {
    idle: "Nothing for anyone to act on yet: CI is still running, the new activity is automated or only acknowledges the work, or it was already handled",
    builder:
      "The builder should act: CI failed, a reviewer asked for a change or asked the author a question, or the branch has merge conflicts",
    human:
      "A person must decide something the builder cannot, such as a product, scope or priority call raised in the discussion",
    merge: "Approved, CI green, mergeable, and nothing new is waiting for an answer",
  },
);
