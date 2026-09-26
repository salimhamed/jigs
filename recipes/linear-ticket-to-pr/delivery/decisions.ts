// The Jev decisions delivery makes, each a question plus the state it is asked about.

import { choice, score } from "@jigs-ai/jigs";

/** Every delivery decision acts only on an answer at least this sure. */
export const CUTOFF = 0.9;

/** A comment added since the builder last assessed the pull request. */
export type NewComment = {
  id: number;
  user: string;
  body: string;
  path?: string;
  /** The comment triage label, when triage was confident. */
  kind?: CommentKind;
};

/** What changed on the pull request since the builder last assessed it. */
export type PullRequestWakeState = {
  ci: "red" | "green" | "pending" | "none";
  failingChecks: { name: string }[];
  approval: "approved" | "changes-requested" | "stale" | "none";
  mergeState: string;
  newComments: Omit<NewComment, "id">[];
  newReviews: { user: string; state: string; body: string }[];
};

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

const commentKinds = {
  question: "Asks the author something that needs an answer",
  "change-request": "Asks for a change to the code, tests or pull request",
  fyi: "Shares information and asks for nothing",
  praise: "Thanks, approves or acknowledges the work and asks for nothing",
  automated: "Written by a bot or tool, such as a coverage, lint or deploy report",
  "author-reply":
    "The pull request author answering or acknowledging earlier feedback, asking nothing new",
} as const;

export type CommentKind = keyof typeof commentKinds;

/** Comment kinds that owe the builder no work. */
export const quietKinds: ReadonlySet<string> = new Set<CommentKind>([
  "fyi",
  "praise",
  "automated",
  "author-reply",
]);

/** Asked once per new comment, all in one call, against `{ comments: NewComment[] }`. */
export const commentKind = (id: number) =>
  choice(
    `Classify the pull request comment with id ${id} in the state's comments list.`,
    commentKinds,
  );

/** The review rounds so far, for judging whether another round is worth spending. */
export type ReviewConvergenceState = {
  budget: number;
  rounds: {
    round: number;
    blocking: string[];
    nonBlocking: number;
    responses: { finding: string; changed: boolean }[];
  }[];
};

/** The `reviewConvergence` level that stops the review loop early. */
export const STALLED = 2;

/** Asked after a blocked review round, before spending another. */
export const reviewConvergence = score(
  "An AI builder and an AI reviewer alternate rounds until the reviewer raises no blocking finding. Given each round's blocking findings and the builder's responses, is the work converging on approval, or are the same findings coming back?",
  [
    "Converging: blocking findings are shrinking or new, and the builder is addressing them",
    "Slow: progress is being made but some findings recur",
    "Stalled: the same blocking findings recur or the builder keeps declining them",
  ],
);
