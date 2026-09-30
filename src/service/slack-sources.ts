// The Slack sources: top-level channel messages, polled from
// `conversations.history` and pushed over Socket Mode. Both deliveries go
// through the same rule, so a polled and a pushed message never disagree.

import { z } from "zod";
import { plainHint } from "../errors.ts";
import { type SlackAuth, type SlackMessage, slackBot, slackHistory } from "../providers/slack.ts";
import type { SlackMessageEvent } from "./slack-socket.ts";
import type { Source, SourceOccurrence } from "./sources.ts";

// A direct message's ID starts with D, so the ID alone keeps DMs out of polling.
const paramsSchema = z.strictObject({
  channels: z
    .array(z.string().regex(/^[CG][A-Z0-9]+$/, "must be a channel ID such as C0123ABCD"))
    .min(1),
});
type Params = z.output<typeof paramsSchema>;

const CHANNEL_TYPES = new Set(["channel", "group"]);

// An allowlist, so a subtype Slack adds later stays out until it is known to
// be a new post. `thread_broadcast` is a reply, however it is shown.
const NEW_POST_SUBTYPES = new Set([undefined, "bot_message", "file_share", "me_message"]);

// The bot's own posts are skipped by author, which ADR 0011 allows because
// the factory's app only ever acts as itself.
function startsRun(message: SlackMessage, bot: SlackAuth, mentionsOnly: boolean): boolean {
  if (!NEW_POST_SUBTYPES.has(message.subtype)) return false;
  if (message.thread_ts !== undefined && message.thread_ts !== message.ts) return false;
  if (message.user === bot.userId || message.bot_id === bot.botId) return false;
  return !mentionsOnly || (message.text ?? "").includes(`<@${bot.userId}>`);
}

const occurred = (channel: string, ts: string): SourceOccurrence => ({
  inputs: { channel, ts },
  at: new Date(Number(ts) * 1000),
});

function slackSource(mentionsOnly: boolean): Source<Params> {
  return {
    provider: "slack",
    params: paramsSchema,
    sampleInputs: { channel: "C0123ABCD", ts: "1790723244.335019" },
    occurrence: ({ channel, ts }) => {
      if (typeof channel !== "string" || typeof ts !== "string")
        throw new Error("no channel and ts in the inputs");
      return `${channel}:${ts}`;
    },
    async poll({ channels }, since) {
      const bot = await slackBot();
      const oldest = (since.getTime() / 1000).toFixed(6);
      const found: SourceOccurrence[] = [];
      for (const channel of channels) {
        let messages: SlackMessage[];
        try {
          messages = await slackHistory(channel, { oldest });
        } catch (error) {
          // Skipped, not retried: the window still advances, so this channel's
          // messages from this poll are only seen if Socket Mode delivers them.
          const why = error instanceof Error ? error.message : String(error);
          console.log(`[slack] could not poll channel ${channel}: ${why}`);
          console.log(
            plainHint(
              `invite @${bot.user} to ${channel} again, or remove ${channel} from the trigger`,
            ),
          );
          continue;
        }
        for (const message of messages)
          if (startsRun(message, bot, mentionsOnly)) found.push(occurred(channel, message.ts));
      }
      return found;
    },
    async fromPush({ channels }, event) {
      const message = event as SlackMessageEvent;
      if (!channels.includes(message.channel)) return null;
      if (!CHANNEL_TYPES.has(message.channel_type ?? "")) return null;
      return startsRun(message, await slackBot(), mentionsOnly)
        ? occurred(message.channel, message.ts)
        : null;
    },
  };
}

export const SLACK_SOURCES = {
  "slack.messages": slackSource(false),
  "slack.mentions": slackSource(true),
};
