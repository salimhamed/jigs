/**
 * Someone who posted in Slack.
 *
 * @remarks
 * `id` is the Slack user ID, or the bot ID for an integration that posts
 * without a user. `email` is missing for bots. `isOwnBot` marks the factory's
 * own bot, which is what posts every message jigs sends.
 *
 * @group Slack messages
 */
export interface SlackAuthor {
  id: string;
  name: string;
  email?: string | undefined;
  bot: boolean;
  isOwnBot: boolean;
}

/**
 * One Slack message: its timestamp, which is also its ID in the channel, its
 * `mrkdwn` text and who wrote it.
 *
 * @group Slack messages
 */
export interface SlackPost {
  ts: string;
  text: string;
  author: SlackAuthor;
}

/**
 * A Slack message and its thread, as `fetchSlackMessage` read them, or `gone`
 * when the message was deleted.
 *
 * @remarks
 * `replies` are the thread's replies, oldest first, without the message
 * itself.
 *
 * @group Slack messages
 */
export type SlackMessageSnapshot =
  | { gone: true; channel: string; ts: string }
  | (SlackPost & { gone: false; channel: string; permalink: string; replies: SlackPost[] });
