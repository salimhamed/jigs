import type { SourceDescriptor } from "../factory.ts";

/**
 * Event-trigger sources for Slack, one per trigger in `jigs.config.ts`.
 *
 * @remarks
 * Both read top-level messages in the listed channels, which the factory's
 * bot must be a member of, and start one run per message with the inputs
 * `{ channel, ts }`. Posts from people, other bots and apps count, including
 * posts with files. The factory's own posts never count, and neither do
 * thread replies, edits, deletes, joins or other channel events. Direct
 * messages are never read. Channels are listed by ID, such as `C0123ABCD`,
 * not by name.
 *
 * @example
 * Start a run for every message that mentions the bot in one channel.
 * ```ts
 * import { slack } from "@jigs-ai/jigs";
 *
 * const triggers = {
 *   "answer-questions": {
 *     workflow: "answer",
 *     source: slack.mentions({ channels: ["C0123ABCD"] }),
 *   },
 * };
 * ```
 *
 * @group Factory and workflows
 */
export const slack = {
  /** Every top-level message in the channels. */
  messages: ({ channels }: { channels: string[] }): SourceDescriptor => ({
    kind: "slack.messages",
    params: { channels },
  }),
  /** Only the top-level messages that mention the factory's bot. */
  mentions: ({ channels }: { channels: string[] }): SourceDescriptor => ({
    kind: "slack.mentions",
    params: { channels },
  }),
};
