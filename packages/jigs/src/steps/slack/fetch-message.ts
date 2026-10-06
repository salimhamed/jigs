import {
  SlackApiError,
  type SlackBot,
  type SlackClient,
  type SlackMessage,
  type SlackUser,
  slackBot,
  slackFor,
} from "../../providers/slack.ts";
import { JigsError } from "../../workflow/errors.ts";
import type {
  SlackAuthor,
  SlackMessageSnapshot,
  SlackPost,
} from "../../workflow/slack/snapshot.ts";

// What conversations.replies answers for a message that was deleted.
const GONE_CODES = new Set(["thread_not_found", "message_not_found"]);

// `fatal` is what the SDK's FatalError.is reads: a retry reads the same reply.
class SlackThreadReplyError extends JigsError {
  readonly fatal = true;
  constructor(channel: string, ts: string, threadTs: string) {
    super(
      `the Slack message ${channel} ${ts} is a thread reply; pass its thread's top-level message ts, ${threadTs}`,
    );
    this.name = "SlackThreadReplyError";
  }
}

async function authorOf(
  slack: SlackClient,
  message: SlackMessage,
  bot: SlackBot,
  users: Map<string, Promise<SlackUser>>,
): Promise<SlackAuthor> {
  // A bot's post names the bot itself, so it needs no users.info lookup.
  if (message.bot_id !== undefined || message.user === undefined) {
    const id = message.user ?? message.bot_id ?? "unknown";
    return {
      id,
      name: message.bot_profile?.name ?? id,
      bot: true,
      isOwnBot: message.user === bot.userId || message.app_id === bot.appId,
    };
  }
  let user = users.get(message.user);
  if (user === undefined) {
    user = slack.slackUser(message.user);
    users.set(message.user, user);
  }
  const { id, name, email, bot: isBot } = await user;
  return { id, name, ...(email === undefined ? {} : { email }), bot: isBot, isOwnBot: false };
}

/**
 * Read a Slack message, its permalink and its thread's replies, with each
 * author's name and email, through the Slack installation `installationName` names.
 *
 * @remarks
 * `ts` must be a top-level message. A reply's ts fails the step without a
 * retry, naming the top-level message's ts.
 *
 * @group Read
 */
export async function fetchSlackMessage({
  installationName,
  channel,
  ts,
}: {
  installationName: string;
  channel: string;
  ts: string;
}): Promise<SlackMessageSnapshot> {
  const slack = slackFor(installationName);
  const gone = { gone: true, channel, ts } as const;
  let thread: SlackMessage[];
  try {
    thread = await slack.slackReplies(channel, ts);
  } catch (error) {
    if (error instanceof SlackApiError && GONE_CODES.has(error.code)) return gone;
    throw error;
  }
  const [message, ...replies] = thread;
  // Slack answers a reply's ts with the reply alone, which names its parent.
  if (message?.ts === ts && message.thread_ts !== undefined && message.thread_ts !== ts) {
    throw new SlackThreadReplyError(channel, ts, message.thread_ts);
  }
  // A deleted message that has replies stays in its thread as a tombstone.
  if (message === undefined || message.ts !== ts || message.subtype === "tombstone") {
    console.log(`[slack] snapshot ${channel} ${ts}: gone`);
    return gone;
  }
  const bot = await slackBot(installationName);
  const users = new Map<string, Promise<SlackUser>>();
  const post = async (m: SlackMessage): Promise<SlackPost> => ({
    ts: m.ts,
    text: m.text ?? "",
    author: await authorOf(slack, m, bot, users),
  });
  const [permalink, first, rest] = await Promise.all([
    slack.slackPermalink(channel, ts),
    post(message),
    Promise.all(replies.map(post)),
  ]);
  console.log(`[slack] snapshot ${channel} ${ts}: ${rest.length} replies`);
  return { ...first, gone: false, channel, permalink, replies: rest };
}
