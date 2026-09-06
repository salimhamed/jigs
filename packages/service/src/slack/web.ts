// Everything the running agent asks of Slack's Web API, behind one interface:
// who the bot is, what a thread says, and how a reply gets into it. Injected,
// so the agent, the dispatcher and their tests need no token and no network.

// Static, not a dynamic import: see the note in connection.ts — the e2e boot
// stage is what proves a `link:`-installed factory resolves this package.
import { WebClient } from "@slack/web-api";

/** The fields of a Slack message this service reads. Everything else in the
 *  payload is Slack's business. */
export interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
}

/** Who this app is in the workspace, as `auth.test` answers it. Both ids,
 *  because a post of the bot's own carries `bot_id` while a message it wrote
 *  as a user carries `user`. */
export interface BotIdentity {
  userId: string | null;
  botId: string | null;
}

export interface SlackWeb {
  authTest(): Promise<BotIdentity>;
  /** The thread, oldest first, ending with `trigger` — the message being
   *  answered. */
  replies(
    channel: string,
    threadTs: string,
    trigger: SlackMessage,
  ): Promise<SlackMessage[]>;
  post(channel: string, threadTs: string, text: string): Promise<void>;
  /** Posts to the channel outside any thread and answers with the new
   *  message's own ts — which is the thread id every reply to it hangs under.
   *  Null when Slack accepted the message without naming one. */
  open(channel: string, text: string): Promise<string | null>;
}

/** One `conversations.replies` page, as the paging below reads it. */
export interface RepliesPage {
  messages: SlackMessage[];
  cursor: string | null;
}

const PAGE_SIZE = 200;
// A runaway thread must not page forever; 20 pages is 4000 messages, well
// past the point where only the tail below survives anyway.
const MAX_PAGES = 20;
// What the model actually reads. The whole thread is fetched first because
// conversations.replies pages from the parent *forward* — stopping at the
// first page keeps the oldest turns and throws away the newest, including the
// message being answered.
const THREAD_TAIL = 60;

/**
 * The newest turns, with the triggering message forced onto the end. That
 * last step is not belt-and-braces: Slack's own read of a thread can lag the
 * event that announced it, and answering a question the model was never shown
 * is the worst failure this has.
 */
export function threadTail(
  messages: readonly SlackMessage[],
  trigger: SlackMessage,
): SlackMessage[] {
  const tail = messages.slice(-THREAD_TAIL);
  if (tail.some((message) => message.ts === trigger.ts)) return tail;
  return [...tail, trigger].slice(-THREAD_TAIL);
}

export async function pageThread(
  fetchPage: (cursor: string | null) => Promise<RepliesPage>,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: RepliesPage = await fetchPage(cursor);
    messages.push(...result.messages);
    if (result.cursor === null || result.cursor === "") break;
    cursor = result.cursor;
  }
  return messages;
}

export function slackWeb(botToken: string): SlackWeb {
  const client = new WebClient(botToken);
  return {
    authTest: async () => {
      const auth = (await client.auth.test()) as {
        user_id?: string;
        bot_id?: string;
      };
      return { userId: auth.user_id ?? null, botId: auth.bot_id ?? null };
    },
    replies: async (channel, threadTs, trigger) => {
      const messages = await pageThread(async (cursor) => {
        const result = await client.conversations.replies({
          channel,
          ts: threadTs,
          limit: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        });
        return {
          messages: (result.messages ?? []) as SlackMessage[],
          // A cursor without has_more is Slack offering a page it has nothing
          // to put in; both have to say there is more before another round
          // trip is worth making.
          cursor:
            result.has_more === true
              ? (result.response_metadata?.next_cursor ?? null)
              : null,
        };
      });
      return threadTail(messages, trigger);
    },
    post: async (channel, threadTs, text) => {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text });
    },
    open: async (channel, text) => {
      const result = await client.chat.postMessage({ channel, text });
      return typeof result.ts === "string" ? result.ts : null;
    },
  };
}
