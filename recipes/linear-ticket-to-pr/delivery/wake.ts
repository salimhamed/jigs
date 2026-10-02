import { type PullRequestSnapshot, parseMarkers } from "@jigs-ai/jigs";

// A bot edits its sticky comment on every push; only its new comments are news.
const edition = (comment: { id: number; updatedAt: string }, bot: boolean) =>
  bot ? `${comment.id}` : `${comment.id}:${comment.updatedAt}`;

// A status note this delivery posted, such as a blocked merge, is not
// something for the builder to answer.
const ownNote = (comment: { body: string }, scope: string) =>
  parseMarkers(comment.body).some((marker) => marker.scope === scope && marker.kind === "status");

/** New or edited comments, one string each, leaving out `scope`'s own status notes. */
export function commentFacts(snapshot: PullRequestSnapshot, scope: string): string[] {
  return [
    ...snapshot.reviewThreads.flatMap((thread) =>
      thread.comments
        .filter((comment) => !ownNote(comment, scope))
        .map((comment) => `thread-comment:${edition(comment, comment.user.endsWith("[bot]"))}`),
    ),
    ...snapshot.conversationComments
      .filter((comment) => !ownNote(comment, scope))
      .map((comment) => `comment:${edition(comment, comment.userType === "Bot")}`),
  ];
}

/**
 * The facts in a snapshot the builder can act on, one string each. The builder
 * is woken only for a fact it has not seen: checks that queue, run or pass, a
 * bare approval and label changes are none of its business.
 */
export function builderWakeFacts(snapshot: PullRequestSnapshot, scope: string): string[] {
  const { headSha } = snapshot;
  return [
    ...snapshot.reviews
      .filter((review) => review.body.trim() !== "" || review.state === "CHANGES_REQUESTED")
      .map((review) => `review:${review.id}:${review.body}`),
    ...commentFacts(snapshot, scope),
    // Keyed by head: the same check failing again after a push is a new failure.
    ...snapshot.failingChecks.map((check) => `failed:${headSha}:${check.name}`),
    ...(snapshot.mergeState === "dirty" ? [`dirty:${headSha}`] : []),
  ];
}
