import { createHook } from "workflow";
import type { fetchSlackMessage } from "../../steps/slack/fetch-message.ts";
import { JigsError } from "../errors.ts";
import type { SlackPost } from "./snapshot.ts";
import { slackThreadToken } from "./thread-token.ts";

/**
 * The durable Slack read a thread-reply wait needs.
 *
 * @group Factory plumbing
 */
export interface SlackReplySteps {
  fetchSlackMessage: typeof fetchSlackMessage;
}

/**
 * The message a wait answers: the thread it is in, named by the ts of the
 * thread's top-level message (never a reply's), and the ts of the question
 * itself. Only replies posted after `after` count.
 *
 * @group Slack messages
 */
export interface SlackQuestion {
  channel: string;
  threadTs: string;
  after: string;
}

// Slack timestamps are seconds and microseconds, too many digits for a
// double to order exactly.
function tsValue(ts: string): bigint {
  const [seconds = "0", micros = ""] = ts.split(".");
  return BigInt(seconds + micros.padEnd(6, "0").slice(0, 6));
}

/**
 * Wait, with no time limit, for a human to reply in a Slack thread after the
 * question, and return the first such reply.
 *
 * @remarks
 * Waits until a reply or `jigs cancel`. Socket Mode, the service's poll and
 * `jigs poke` each make it read the thread again. Replies from bots,
 * including the factory's own, never count. `threadTs` must be the thread's
 * top-level message: a reply's ts fails the wait, naming the top-level
 * message's ts. Deleting the message while the run waits fails the run. When
 * a human reply is already in the thread, every run waiting on it returns
 * that reply; a second run that has to park while another waits on the
 * thread fails with the Workflow SDK's `HookConflictError`.
 *
 * @group Slack messages
 */
export async function waitForSlackReply(
  question: SlackQuestion,
  steps: SlackReplySteps,
): Promise<SlackPost> {
  const { fetchSlackMessage } = steps;
  const { channel, threadTs, after } = question;
  const token = slackThreadToken(channel, threadTs);
  // The wake carries nothing; it only makes the routine read the thread again.
  const hook = createHook<unknown>({ token });
  try {
    const since = tsValue(after);
    while (true) {
      const thread = await fetchSlackMessage({ channel, ts: threadTs });
      if (thread.gone) {
        throw new JigsError(
          `the Slack message ${channel} ${threadTs} was deleted while this run waited for a reply in its thread`,
        );
      }
      const reply = thread.replies.find((post) => !post.author.bot && tsValue(post.ts) > since);
      if (reply !== undefined) return reply;
      await hook;
    }
  } finally {
    hook.dispose();
  }
}
