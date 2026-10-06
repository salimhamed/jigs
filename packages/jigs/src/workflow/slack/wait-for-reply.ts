import { createHook, sleep } from "workflow";
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
 * The thread a wait reads, named by the ts of its top-level message (never a
 * reply's). `lastRead` is the ts of the newest post the workflow has read,
 * never its own question; only human replies after it count. `until`, an
 * ISO 8601 timestamp, is when to stop waiting.
 *
 * @group Slack messages
 */
export interface SlackQuestion {
  /** The Slack installation, as named on the hub, the thread is read through; only its events wake the wait. */
  installationName: string;
  channel: string;
  threadTs: string;
  lastRead: string;
  until?: string;
}

/**
 * How `waitForSlackReply` ended: `replied` with the new human replies (oldest first, never
 * empty), `timed-out` at `until`, or `gone` when the thread's top-level message was deleted.
 *
 * @group Slack messages
 */
export type SlackReplyResult =
  | { outcome: "replied"; replies: SlackPost[] }
  | { outcome: "timed-out" }
  | { outcome: "gone" };

// Slack timestamps are seconds and microseconds, too many digits for a
// double to order exactly.
function tsValue(ts: string): bigint {
  const [seconds = "0", micros = ""] = ts.split(".");
  return BigInt(seconds + micros.padEnd(6, "0").slice(0, 6));
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Wait for a human to reply in a Slack thread after `lastRead`, and return
 * every such reply. Ends `timed-out` once `until` passes, and `gone` when the
 * thread's top-level message is deleted.
 *
 * @remarks
 * Without `until`, waits until a reply or `jigs cancel`. With it, the thread is
 * read at least once, so a reply already there wins even when `until` has
 * passed; after that the wait ends `timed-out` at `until`, and a later
 * reply wakes nothing. A reply heard through the hub and `jigs poke` each make
 * it read the thread again. Replies from bots, including the factory's
 * own, never count. `threadTs` must be the thread's top-level message: a
 * reply's ts fails the wait, naming the top-level message's ts. A reply
 * already in the thread returns at once, and may not answer the question the
 * workflow just asked. When a human reply is already in the thread, every run
 * waiting on it returns them; a second run that has to park while another waits
 * on the thread fails with the Workflow SDK's `HookConflictError`.
 *
 * @group Slack messages
 */
export async function waitForSlackReply(
  question: SlackQuestion,
  steps: SlackReplySteps,
): Promise<SlackReplyResult> {
  const { fetchSlackMessage } = steps;
  const { installationName, channel, threadTs, lastRead, until } = question;
  const deadline = until === undefined ? undefined : new Date(until);
  if (
    deadline !== undefined &&
    (!ISO_TIMESTAMP.test(until ?? "") || Number.isNaN(deadline.getTime()))
  ) {
    throw new JigsError(`until must be an ISO 8601 timestamp, got ${JSON.stringify(until)}`);
  }
  const token = slackThreadToken(installationName, channel, threadTs);
  // The wake carries nothing; it only makes the routine read the thread again.
  const hook = createHook<unknown>({ token });
  let expired: Promise<"timed-out"> | undefined;
  try {
    const since = tsValue(lastRead);
    while (true) {
      const thread = await fetchSlackMessage({ installationName, channel, ts: threadTs });
      if (thread.gone) return { outcome: "gone" };
      const replies = thread.replies.filter((post) => !post.author.bot && tsValue(post.ts) > since);
      if (replies.length > 0) return { outcome: "replied", replies };
      if (deadline === undefined) {
        await hook;
        continue;
      }
      // The workflow clock replays deterministically, so this check does too.
      if (Date.now() >= deadline.getTime()) return { outcome: "timed-out" };
      // One durable timer per call, created only once the routine has to park.
      // The SDK cannot cancel it, so a run that got its reply wakes once more at `until`.
      expired ??= sleep(deadline).then(() => "timed-out" as const);
      if ((await Promise.race([hook.then(() => "woken" as const), expired])) === "timed-out") {
        return { outcome: "timed-out" };
      }
    }
  } finally {
    hook.dispose();
  }
}
