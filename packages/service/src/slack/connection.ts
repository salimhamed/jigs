// The connection layer: this factory's Slack app holds one Socket Mode
// socket, and every event that survives the allowlist is handed to the
// dispatcher as a thread to answer. What an answer is lives in dispatch.ts.

// Static, not the dynamic import start-world.ts uses for its heavy deps: a
// factory installs @jigs/service by `link:`, so an import added here resolves
// only if the factory declares the package too, and the e2e boot stage is the
// only place in this repo that can see it fail.
import { SocketModeClient } from "@slack/socket-mode";
import { isAllowedSpeaker } from "./allowlist";
import type { SlackDispatcher } from "./dispatch";

/** The slice of `SocketModeClient` this module uses. Injected so a test needs
 *  no websocket, no app token and no network. */
export interface SocketModeLike {
  start(): Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: eventemitter3's listener signature
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** One inbound envelope as `slack_event` delivers it. The catch-all carries
 *  `body` but not the inner event, so the routing below digs it out itself.
 *  `retry_num` is Slack saying it has sent this one before. */
export interface SlackEnvelope {
  ack(response?: unknown): Promise<void>;
  envelope_id: string;
  type: string;
  body: unknown;
  retry_num?: number;
}

interface SlackInnerEvent {
  type?: unknown;
  user?: unknown;
  channel?: unknown;
  ts?: unknown;
  text?: unknown;
  thread_ts?: unknown;
  bot_id?: unknown;
  subtype?: unknown;
}

export type SlackRouting =
  | { kind: "ignored" }
  | { kind: "denied"; user: string }
  | {
      kind: "accepted";
      channel: string;
      user: string;
      ts: string;
      text: string;
      thread: string | null;
    };

/**
 * What an envelope is, before anything is done about it. Pure, and the first
 * of the two places the allowlist is applied (threads.ts is the other, over
 * the thread history): a message from anyone else must not reach a model, a
 * log line about its text, or a reply.
 */
export function routeSlackEnvelope(
  envelope: SlackEnvelope,
  allowedUsers: readonly string[],
): SlackRouting {
  if (envelope.type !== "events_api") return { kind: "ignored" };
  const event = (envelope.body as { event?: SlackInnerEvent } | null)?.event;
  if (event === undefined || event === null) return { kind: "ignored" };
  // `message` alone, never `app_mention`: Slack delivers a channel mention as
  // both, and two subscriptions to one utterance is two acks and two answers.
  // A mention is an ordinary message whose text holds the id.
  if (event.type !== "message") return { kind: "ignored" };
  // A bot_id is this app's own post coming back, or another app's — echoing it
  // is how a bot talks to itself forever. A subtype is anything but a plain
  // new message (an edit, a deletion, a join, a file share, a thread
  // broadcast); some of those are a person speaking, and none of them is in
  // scope until there is something here that knows what to do with one.
  if (event.bot_id !== undefined || event.subtype !== undefined) {
    return { kind: "ignored" };
  }
  const user = typeof event.user === "string" ? event.user : null;
  if (user === null) return { kind: "ignored" };
  // Every conversation is a thread, and a reply needs the ts to open one
  // under. A message without one is not addressable.
  const channel = typeof event.channel === "string" ? event.channel : null;
  const ts = typeof event.ts === "string" ? event.ts : null;
  if (channel === null || ts === null) return { kind: "ignored" };
  if (!isAllowedSpeaker(user, allowedUsers)) return { kind: "denied", user };
  return {
    kind: "accepted",
    channel,
    user,
    ts,
    text: typeof event.text === "string" ? event.text : "",
    thread: typeof event.thread_ts === "string" ? event.thread_ts : null,
  };
}

// One utterance answered once. Slack redelivers an envelope whose ack it did
// not see, and the ack path below deliberately makes that happen — so the
// message's own identity, not the envelope's, is what says "already done".
// Bounded, because the alternative is a set that grows for the life of the
// process.
const SEEN_LIMIT = 500;

export class DispatchedMessages {
  private readonly seen = new Set<string>();

  /** True the first time this message is offered, false for every
   *  redelivery of it. */
  claim(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    // Insertion-ordered, so the first key is the oldest.
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }
}

export interface SlackHandlerOptions {
  allowedUsers: readonly string[];
  log: (line: string) => void;
  error: (line: string) => void;
  dispatch?: SlackDispatcher;
  dispatched?: DispatchedMessages;
}

export async function handleSlackEnvelope(
  envelope: SlackEnvelope,
  options: SlackHandlerOptions,
): Promise<SlackRouting> {
  if (envelope.retry_num !== undefined && envelope.retry_num > 0) {
    options.log(
      `[slack] redelivery attempt=${envelope.retry_num} envelope=${envelope.envelope_id}`,
    );
  }
  // Acknowledged first: Slack redelivers an envelope nobody acknowledged.
  try {
    await envelope.ack();
  } catch (err) {
    // And that redelivery is the retry — answering an unacked envelope means
    // answering the copy Slack is already sending, twice.
    options.error(
      `[slack] ack failed for envelope ${envelope.envelope_id}, leaving it to Slack's redelivery: ${describe(err)}`,
    );
    return { kind: "ignored" };
  }
  const routing = routeSlackEnvelope(envelope, options.allowedUsers);
  if (routing.kind === "denied") {
    options.log(`[slack] ignored message from ${routing.user}`);
  } else if (routing.kind === "accepted") {
    if (options.dispatched?.claim(routing.channel, routing.ts) === false) {
      options.log(
        `[slack] already answered channel=${routing.channel} ts=${routing.ts}`,
      );
      return routing;
    }
    options.log(
      `[slack] message channel=${routing.channel} thread=${routing.thread ?? "none"} user=${routing.user}`,
    );
    // A top-level message's reply opens the thread under it; one already in a
    // thread stays in that thread.
    void options.dispatch?.({
      channel: routing.channel,
      threadTs: routing.thread ?? routing.ts,
      message: { ts: routing.ts, text: routing.text, user: routing.user },
    });
  }
  return routing;
}

export interface SlackConnectionOptions {
  appToken: string;
  allowedUsers: readonly string[];
  dispatch?: SlackDispatcher;
  client?: SocketModeLike;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Opens the socket and resolves once Slack has accepted it. Reconnects are
 * the SDK's job (`autoReconnectEnabled` defaults on), so a rejection here is
 * Slack refusing the app token outright rather than a socket worth retrying.
 */
export async function connectSlack(
  options: SlackConnectionOptions,
): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const client =
    options.client ?? new SocketModeClient({ appToken: options.appToken });
  // One per connection, so a reconnect does not re-answer the backlog Slack
  // replays over it.
  const dispatched = new DispatchedMessages();

  client.on("connected", () => log("[slack] connected"));
  client.on("disconnected", () => log("[slack] disconnected"));
  client.on("error", (err: unknown) =>
    error(`[slack] socket error: ${describe(err)}`),
  );
  // The catch-all rather than the inner `message`/`app_mention` events: the
  // SDK emits both for the same envelope, and two subscriptions would ack it
  // twice.
  client.on("slack_event", (envelope: SlackEnvelope) => {
    void handleSlackEnvelope(envelope, {
      allowedUsers: options.allowedUsers,
      log,
      error,
      dispatch: options.dispatch,
      dispatched,
    });
  });

  await client.start();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
