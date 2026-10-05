// The Slack sources: top-level channel messages, pushed as Events API bodies
// through the hub.

import { z } from "zod";
import { type SlackBot, type SlackMessage, slackBot } from "../providers/slack.ts";
import type { Source, SourceOccurrence } from "./event-triggers/sources.ts";

// A direct message's ID starts with D, so a trigger can never name one.
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

/** A channel message event as the Events API delivers it: the message, and where it was posted. */
interface SlackMessageEvent extends SlackMessage {
  type: "message";
  channel: string;
  /** `channel` or `group` for a public or private channel, `im` or `mpim` for a direct message. */
  channel_type?: string;
}

const callbackSchema = z.object({
  type: z.literal("event_callback"),
  event: z.object({ type: z.literal("message"), channel: z.string(), ts: z.string() }).loose(),
});

// The bot's own posts are skipped by author, which ADR 0011 allows because
// the factory's app only ever acts as itself. A post under a custom username
// carries only the app's id.
function startsRun(message: SlackMessage, bot: SlackBot, mentionsOnly: boolean): boolean {
  if (!NEW_POST_SUBTYPES.has(message.subtype)) return false;
  if (message.thread_ts !== undefined && message.thread_ts !== message.ts) return false;
  if (message.user === bot.userId || message.app_id === bot.appId) return false;
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
    async fromPush({ channels }, body) {
      const callback = callbackSchema.safeParse(body).data;
      if (callback === undefined) return null;
      const message = callback.event as SlackMessageEvent;
      if (!channels.includes(message.channel)) return null;
      if (!CHANNEL_TYPES.has(message.channel_type ?? "")) return null;
      return startsRun(message, await slackBot(), mentionsOnly)
        ? occurred(message.channel, message.ts)
        : null;
    },
    describe: ({ channel, ts }) => `slack ${String(channel)} ${String(ts)}`,
  };
}

export const SLACK_SOURCES = {
  "slack.messages": slackSource(false),
  "slack.mentions": slackSource(true),
};
