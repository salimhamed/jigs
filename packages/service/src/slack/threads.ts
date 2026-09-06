// The thread is the conversation store: Slack already keeps every turn in
// order, so jigs keeps none of its own. This is the whole translation, and
// the second place the allowlist is applied — a channel the bot is in is a
// channel anyone in the workspace can write into, so a thread's history
// carries words this factory never agreed to listen to.

import type { ModelMessage } from "ai";
import { isAllowedSpeaker } from "./allowlist";
import type { BotIdentity, SlackMessage } from "./web";

/**
 * The thread as the model reads it — the bot's own posts are its turns, an
 * allowlisted human's are the operator's, and everyone else is dropped
 * outright rather than quoted, because a turn in the prompt is a turn the
 * model may act on. A message with no text (a file share, a bare attachment)
 * contributes nothing either.
 */
export function threadToMessages(
  messages: readonly SlackMessage[],
  bot: BotIdentity,
  allowedUsers: readonly string[],
): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    const content = (message.text ?? "").trim();
    if (content === "") return [];
    if (spokenByBot(message, bot)) return [{ role: "assistant", content }];
    if (!isAllowedSpeaker(message.user, allowedUsers)) return [];
    return [{ role: "user", content }];
  });
}

// Identity, not "is a bot": another app posting in the thread is somebody
// else talking, and it is on the allowlist or it is dropped like anyone else.
function spokenByBot(message: SlackMessage, bot: BotIdentity): boolean {
  if (bot.botId !== null && message.bot_id === bot.botId) return true;
  return bot.userId !== null && message.user === bot.userId;
}
