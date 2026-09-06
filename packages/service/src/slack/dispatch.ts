// Accepted message → thread history → agent → reply, one thread at a time.
//
// Serialized per thread because the thread *is* the context: two answers being
// composed at once each read a history missing the other's reply, and the
// operator gets two half-answers to a conversation they were having once.
// Different threads share nothing, so they run concurrently — deliberately
// without a ceiling, because only allowlisted users can get a thread answered
// at all, which makes the fan-out the size of one small team rather than a
// workspace.

import type { ModelMessage } from "ai";
import type { ThreadRunContext } from "./agent";
import { threadToMessages } from "./threads";
import type { BotIdentity, SlackMessage } from "./web";

/** Which thread a reply belongs in, and the message being answered. For a
 *  top-level message `threadTs` is that message's own ts — the reply opens
 *  the thread. */
export interface ThreadRef {
  channel: string;
  threadTs: string;
  message: SlackMessage;
}

/** What the answer is being composed about: the thread, and the run that
 *  thread belongs to when it belongs to one. */
export interface AnswerContext {
  thread: ThreadRef;
  run: ThreadRunContext | null;
}

export interface SlackDispatchDeps {
  bot: BotIdentity;
  allowedUsers: readonly string[];
  fetchThread(
    channel: string,
    threadTs: string,
    trigger: SlackMessage,
  ): Promise<SlackMessage[]>;
  /** Which run this thread is about, if any. Optional: a factory whose World
   *  has no thread table answers every question without the shortcut. */
  runContext?(thread: ThreadRef): Promise<ThreadRunContext | null>;
  answer(messages: ModelMessage[], context: AnswerContext): Promise<string>;
  post(channel: string, threadTs: string, text: string): Promise<void>;
  error(line: string): void;
}

/** Returns the promise for this message's turn, so a test can await it; the
 *  socket handler drops it on the floor by design. */
export type SlackDispatcher = (thread: ThreadRef) => Promise<void>;

export function createSlackDispatcher(
  deps: SlackDispatchDeps,
): SlackDispatcher {
  const queues = new Map<string, Promise<void>>();
  return (thread) => {
    const key = `${thread.channel}:${thread.threadTs}`;
    const next = (queues.get(key) ?? Promise.resolve()).then(() =>
      answerOne(thread, deps),
    );
    queues.set(key, next);
    // Or the map keeps one entry per thread for the life of the process.
    void next.then(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    return next;
  };
}

// Never rejects: the chain above is what keeps a thread in order, and a
// rejection would poison every later message in it. The service must survive
// any message.
async function answerOne(
  thread: ThreadRef,
  deps: SlackDispatchDeps,
): Promise<void> {
  try {
    const [history, run] = await Promise.all([
      deps.fetchThread(thread.channel, thread.threadTs, thread.message),
      deps.runContext === undefined ? null : deps.runContext(thread),
    ]);
    const reply = await deps.answer(
      threadToMessages(history, deps.bot, deps.allowedUsers),
      { thread, run },
    );
    await deps.post(thread.channel, thread.threadTs, reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.error(
      `[slack] thread ${thread.channel}/${thread.threadTs} failed: ${
        err instanceof Error ? (err.stack ?? message) : message
      }`,
    );
    // One line in the thread, not the stack: the operator needs to know the
    // question was heard and dropped, and the detail is in the service log.
    await deps
      .post(thread.channel, thread.threadTs, `I hit an error: ${message}`)
      .catch((postErr: unknown) =>
        deps.error(`[slack] could not report that error: ${String(postErr)}`),
      );
  }
}
