// The Slack sources: top-level channel messages, polled from
// `conversations.history` and pushed as Events API bodies through the hub.
// Both deliveries go through the same rule, so a polled and a pushed message
// never disagree.

import { z } from "zod";
import { plainHint } from "../errors.ts";
import { type SlackBot, type SlackMessage, slackBot, slackHistory } from "../providers/slack.ts";
import type { Source, SourceOccurrence } from "./event-triggers/sources.ts";

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

const slackTs = (at: Date) => (at.getTime() / 1000).toFixed(6);

// Each channel's own `oldest`: one channel that cannot be read holds back
// only itself, so the others' new messages still start runs.
const cursorSchema = z.record(z.string(), z.string().regex(/^\d+\.\d{6}$/));
type Cursor = z.output<typeof cursorSchema>;

function slackSource(mentionsOnly: boolean, now: () => Date): Source<Params, Cursor> {
  return {
    provider: "slack",
    params: paramsSchema,
    cursor: cursorSchema,
    sampleInputs: { channel: "C0123ABCD", ts: "1790723244.335019" },
    occurrence: ({ channel, ts }) => {
      if (typeof channel !== "string" || typeof ts !== "string")
        throw new Error("no channel and ts in the inputs");
      return `${channel}:${ts}`;
    },
    async poll({ channels }, cursor, floor) {
      const bot = await slackBot();
      const floorTs = slackTs(floor);
      const occurrences: SourceOccurrence[] = [];
      const next: Cursor = {};
      for (const channel of channels) {
        const held = cursor?.[channel];
        const oldest = held !== undefined && Number(held) > Number(floorTs) ? held : floorTs;
        // Taken before the read, so a message landing during it is read again
        // next time; the engine drops the repeat.
        const through = slackTs(now());
        let messages: SlackMessage[];
        try {
          messages = await slackHistory(channel, { oldest });
        } catch (error) {
          if (held !== undefined) next[channel] = held;
          const why = error instanceof Error ? error.message : String(error);
          console.log(`[slack] could not poll channel ${channel}: ${why}`);
          console.log(
            plainHint(
              `invite @${bot.name} to ${channel} again, or remove ${channel} from the trigger`,
            ),
          );
          continue;
        }
        for (const message of messages)
          if (startsRun(message, bot, mentionsOnly))
            occurrences.push(occurred(channel, message.ts));
        next[channel] = through;
      }
      return { occurrences, cursor: next };
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

export function slackSources(now: () => Date = () => new Date()) {
  return {
    "slack.messages": slackSource(false, now),
    "slack.mentions": slackSource(true, now),
  };
}

export const SLACK_SOURCES = slackSources();
