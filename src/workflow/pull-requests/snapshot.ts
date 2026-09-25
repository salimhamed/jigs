/** A submitted GitHub review of a pull request. */
export interface PullRequestReview {
  id: number;
  state: string;
  body: string;
  user: string;
  submittedAt: string;
  commitSha?: string;
}

/** A comment anchored to a file in a pull request review. */
export interface ReviewComment {
  id: number;
  rootId: number;
  body: string;
  user: string;
  path: string;
  line: number | null;
  createdAt: string;
  // An edit is a reviewer saying something new, so it is part of what a marker
  // names when jigs records that it answered this comment.
  updatedAt: string;
}

/** A pull request review conversation, with its optional file location. */
export interface ReviewThread {
  rootId: number;
  path: string;
  line: number | null;
  comments: ReviewComment[];
  // Absent on an inline thread. A conversation thread is synthetic — a review
  // summary or a pull request conversation comment — and has no file anchor,
  // so an answer to it is posted on the conversation, not as a thread reply.
  origin?: "conversation";
}

/** A comment on the pull request conversation, which hangs off no thread. */
export interface PullRequestComment {
  id: number;
  body: string;
  user: string;
  // GitHub's account kind does not establish who initiated a message: an agent
  // using a personal token posts as that user.
  userType: string;
  createdAt: string;
  updatedAt: string;
}

/** A check or commit status reported on a pull request head. */
export interface CheckRun {
  name: string;
  conclusion: string | null;
  url: string;
}

/** GitHub facts about a pull request, without a judgment about outstanding work. */
export interface PullRequestSnapshot {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  /**
   * GitHub's own verdict on whether the pull request can merge right now,
   * folding in conflicts, required checks and required reviews. `"clean"` is
   * the only value that permits a merge; `"unknown"` means GitHub has not
   * finished computing it, so the answer is "not yet, ask again".
   */
  mergeState: string;
  /** Label names on the pull request; the `label` approval signal reads these. */
  labels: string[];
  /** The merge commit, once GitHub has made one. */
  mergeCommitSha: string | null;
  reviews: PullRequestReview[];
  reviewThreads: ReviewThread[];
  conversationComments: PullRequestComment[];
  ci: "red" | "green" | "pending";
  failingChecks: CheckRun[];
}

// Snapshot arrays are collections, not sequences: API ordering alone is not new activity.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A comparison key for the facts in a pull request snapshot.
 *
 * @remarks
 * Collection ordering and incidental fields do not change the key. Compare keys for equality;
 * the key format is opaque and is not a durable identifier.
 */
export function pullRequestSnapshotKey(snapshot: PullRequestSnapshot): string {
  // Name the facts explicitly: incidental fetch metadata must not become a wake trigger.
  return canonical({
    state: snapshot.state,
    merged: snapshot.merged,
    draft: snapshot.draft,
    headSha: snapshot.headSha,
    mergeState: snapshot.mergeState,
    labels: snapshot.labels,
    mergeCommitSha: snapshot.mergeCommitSha,
    reviews: snapshot.reviews,
    reviewThreads: snapshot.reviewThreads,
    conversationComments: snapshot.conversationComments,
    ci: snapshot.ci,
    failingChecks: snapshot.failingChecks,
  });
}
