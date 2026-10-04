import { SLACK_THREAD_TOKEN_PREFIX } from "../hook-tokens.ts";

/** Build the hook token for the thread under the message `threadTs`. */
export function slackThreadToken(channel: string, threadTs: string): string {
  return `${SLACK_THREAD_TOKEN_PREFIX}${channel}:${threadTs}`;
}

/** The thread hook token a Slack message event wakes, or null when it is no human's thread reply. */
export function slackThreadTokenFromEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const { channel, ts, thread_ts, bot_id } = event as Record<string, unknown>;
  if (typeof channel !== "string" || typeof thread_ts !== "string") return null;
  // A bot's reply never ends a wait, so waking the run for one only costs a replay.
  if (thread_ts === ts || bot_id !== undefined) return null;
  return slackThreadToken(channel, thread_ts);
}
