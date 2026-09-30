import {
  SlackApiError,
  type SlackAuth,
  type SlackMessage,
  type SlackUser,
  slackBot,
  slackPermalink,
  slackReplies,
  slackUser,
} from "../../providers/slack.ts";
import type {
  SlackAuthor,
  SlackMessageSnapshot,
  SlackPost,
} from "../../workflow/slack/snapshot.ts";

// What conversations.replies answers for a message that was deleted.
const GONE_CODES = new Set(["thread_not_found", "message_not_found"]);

async function authorOf(
  message: SlackMessage,
  bot: SlackAuth,
  users: Map<string, Promise<SlackUser>>,
): Promise<SlackAuthor> {
  // A bot's post names the bot itself, so it needs no users.info lookup.
  if (message.bot_id !== undefined || message.user === undefined) {
    const id = message.user ?? message.bot_id ?? "unknown";
    return {
      id,
      name: message.bot_profile?.name ?? id,
      bot: true,
      isOwnBot: message.bot_id === bot.botId || message.user === bot.userId,
    };
  }
  let user = users.get(message.user);
  if (user === undefined) {
    user = slackUser(message.user);
    users.set(message.user, user);
  }
  const { id, name, email, bot: isBot } = await user;
  return { id, name, ...(email === undefined ? {} : { email }), bot: isBot, isOwnBot: false };
}

/**
 * Read a Slack message, its permalink and its thread's replies, with each
 * author's name and email.
 *
 * @group Read
 */
export async function fetchSlackMessage({
  channel,
  ts,
}: {
  channel: string;
  ts: string;
}): Promise<SlackMessageSnapshot> {
  const gone = { gone: true, channel, ts } as const;
  let thread: SlackMessage[];
  try {
    thread = await slackReplies(channel, ts);
  } catch (error) {
    if (error instanceof SlackApiError && GONE_CODES.has(error.code)) return gone;
    throw error;
  }
  const [message, ...replies] = thread;
  // A deleted message that has replies stays in its thread as a tombstone.
  if (message === undefined || message.ts !== ts || message.subtype === "tombstone") {
    console.log(`[slack] snapshot ${channel} ${ts}: gone`);
    return gone;
  }
  const bot = await slackBot();
  const users = new Map<string, Promise<SlackUser>>();
  const post = async (m: SlackMessage): Promise<SlackPost> => ({
    ts: m.ts,
    text: m.text ?? "",
    author: await authorOf(m, bot, users),
  });
  const [permalink, first, rest] = await Promise.all([
    slackPermalink(channel, ts),
    post(message),
    Promise.all(replies.map(post)),
  ]);
  console.log(`[slack] snapshot ${channel} ${ts}: ${rest.length} replies`);
  return { ...first, gone: false, channel, permalink, replies: rest };
}
