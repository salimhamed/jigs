import { type PullRequestSnapshot, parseMarkers } from "@jigs-ai/jigs";

type Comment = { id: number; body: string; user: string; updatedAt: string };

// A bot edits its sticky comment on every push; only its new comments are news.
const edition = (comment: Comment, bot: boolean) =>
  bot ? `${comment.id}` : `${comment.id}:${comment.updatedAt}`;

// A status note this delivery posted, such as a blocked merge, is not
// something for the builder to answer.
const ownNote = (comment: Comment, scope: string) =>
  parseMarkers(comment.body).some((marker) => marker.scope === scope && marker.kind === "status");

// The builder acts on GitHub as the App's bot, and jigs marks every note it
// posts, so an unmarked comment by the bot is one of the builder's own replies.
const ownReply = (comment: Comment, appBot: string | undefined) =>
  appBot !== undefined &&
  comment.user.toLowerCase() === appBot.toLowerCase() &&
  parseMarkers(comment.body).length === 0;

/** New or edited comments, one string each, leaving out the builder's own replies and notes. */
function commentFacts(snapshot: PullRequestSnapshot, scope: string): string[] {
  const news = (comment: Comment) =>
    !ownNote(comment, scope) && !ownReply(comment, snapshot.appBot);
  return [
    ...snapshot.reviewThreads.flatMap((thread) =>
      thread.comments
        .filter(news)
        .map((comment) => `thread-comment:${edition(comment, comment.user.endsWith("[bot]"))}`),
    ),
    ...snapshot.conversationComments
      .filter(news)
      .map((comment) => `comment:${edition(comment, comment.userType === "Bot")}`),
  ];
}

/**
 * The facts in a snapshot the builder can act on, one string each. The builder
 * is woken only for a fact it has not seen: checks that queue, run or pass, a
 * bare approval, label changes and its own replies are none of its business.
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
