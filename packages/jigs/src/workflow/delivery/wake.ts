import { parseMarkers } from "../pull-requests/marker.ts";
import type { PullRequestSnapshot } from "../pull-requests/snapshot.ts";

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
const ownReply = (comment: Comment, appBot: string) =>
  comment.user.toLowerCase() === appBot.toLowerCase() && parseMarkers(comment.body).length === 0;

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
 * The default wake rule for `followPullRequestToOutcome`: the facts in a snapshot a builder can
 * act on, one string each.
 *
 * @remarks
 * A review with a body or one requesting changes, a new comment or a person's edit of one, a
 * check failing on the current head, and a conflict with the base each wake the builder. Checks
 * that queue, run or pass, a bare approval, label changes, a bot editing its own comment, the App
 * bot's unmarked comments (the builder's own replies) and notes marked with the delivery's
 * `scope` wake nothing. To change the rules, wrap it or pass your own function as `wake`.
 *
 * @example
 * ```ts
 * import { builderWakeFacts, type PullRequestSnapshot } from "@jigs-ai/jigs";
 *
 * // Also ignore a coverage bot's comments.
 * const wake = (snapshot: PullRequestSnapshot, scope: string) =>
 *   builderWakeFacts(
 *     {
 *       ...snapshot,
 *       conversationComments: snapshot.conversationComments.filter(
 *         (comment) => comment.user !== "codecov[bot]",
 *       ),
 *     },
 *     scope,
 *   );
 * ```
 *
 * @group Pull request delivery
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
