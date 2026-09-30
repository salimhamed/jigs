// The Slack sources: top-level channel messages, polled from
// `conversations.history` and pushed over Socket Mode. Both deliveries go
// through the same rule, so a polled and a pushed message never disagree.

import { z } from "zod";
import { JigsError } from "../errors.ts";
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

// The bot's own posts are skipped by author, which ADR 0011 allows because
// the factory's app only ever acts as itself.
function counts(message: SlackMessage, bot: SlackAuth, mentionsOnly: boolean): boolean {
  if (message.subtype !== undefined) return false;
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
          throw new JigsError(
            `channel ${channel}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        for (const message of messages)
          if (counts(message, bot, mentionsOnly)) found.push(occurred(channel, message.ts));
      }
      return found;
    },
    async fromPush({ channels }, event) {
      const message = event as SlackMessageEvent;
      if (!channels.includes(message.channel)) return null;
      if (!CHANNEL_TYPES.has(message.channel_type ?? "")) return null;
      return counts(message, await slackBot(), mentionsOnly)
        ? occurred(message.channel, message.ts)
        : null;
    },
  };
}

export const SLACK_SOURCES = {
  "slack.messages": slackSource(false),
  "slack.mentions": slackSource(true),
};
