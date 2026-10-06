import type { SourceDescriptor } from "../factory.ts";

/**
 * Event-trigger sources for Slack, one per trigger in `jigs.config.ts`.
 *
 * @remarks
 * Both read top-level messages in the listed channels of one Slack
 * installation, named as on the hub, whose bot must be a member of them, and
 * start one run per message with the inputs `{ installationName, channel, ts }`. Posts from people, other bots and apps count, including
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
 *     source: slack.mentions({ installationName: "acme", channels: ["C0123ABCD"] }),
 *   },
 * };
 * ```
 *
 * @group Factory and workflows
 */
export const slack = {
  /** Every top-level message in the channels. */
  messages: ({
    installationName,
    channels,
  }: {
    installationName: string;
    channels: string[];
  }): SourceDescriptor => ({
    kind: "slack.messages",
    params: { installationName, channels },
  }),
  /** Only the top-level messages that mention the factory's bot. */
  mentions: ({
    installationName,
    channels,
  }: {
    installationName: string;
    channels: string[];
  }): SourceDescriptor => ({
    kind: "slack.mentions",
    params: { installationName, channels },
  }),
};
