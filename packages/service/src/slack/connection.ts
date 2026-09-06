// The connection layer only: this factory's Slack app holds one Socket Mode
// socket, and every event that survives the allowlist is logged and dropped.
// Threads, replies and the agent are later PRs.

// Static, not the dynamic import start-world.ts uses for its heavy deps: a
// factory installs @jigs/service by `link:`, so an import added here resolves
// only if the factory declares the package too, and the e2e boot stage is the
// only place in this repo that can see it fail.
import { SocketModeClient } from "@slack/socket-mode";

/** The slice of `SocketModeClient` this module uses. Injected so a test needs
 *  no websocket, no app token and no network. */
export interface SocketModeLike {
  start(): Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: eventemitter3's listener signature
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** One inbound envelope as `slack_event` delivers it. The catch-all carries
 *  `body` but not the inner event, so the routing below digs it out itself. */
export interface SlackEnvelope {
  ack(response?: unknown): Promise<void>;
  envelope_id: string;
  type: string;
  body: unknown;
}

interface SlackInnerEvent {
  type?: unknown;
  user?: unknown;
  channel?: unknown;
  thread_ts?: unknown;
  bot_id?: unknown;
  subtype?: unknown;
}

export type SlackRouting =
  | { kind: "ignored" }
  | { kind: "denied"; user: string }
  | { kind: "accepted"; channel: string; user: string; thread: string | null };

/**
 * What an envelope is, before anything is done about it. Pure, and the only
 * place the allowlist is applied — a message from anyone else must not reach
 * a model, a log line about its text, or a reply.
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
  if (!allowedUsers.includes(user)) return { kind: "denied", user };
  return {
    kind: "accepted",
    channel: typeof event.channel === "string" ? event.channel : "unknown",
    user,
    thread: typeof event.thread_ts === "string" ? event.thread_ts : null,
  };
}

export interface SlackHandlerOptions {
  allowedUsers: readonly string[];
  log: (line: string) => void;
  error: (line: string) => void;
}

export async function handleSlackEnvelope(
  envelope: SlackEnvelope,
  options: SlackHandlerOptions,
): Promise<SlackRouting> {
  // Acknowledged first and unconditionally: Slack redelivers an envelope
  // nobody acknowledged, and nothing below is worth a retry.
  try {
    await envelope.ack();
  } catch (err) {
    options.error(
      `[slack] ack failed for envelope ${envelope.envelope_id}: ${describe(err)}`,
    );
  }
  const routing = routeSlackEnvelope(envelope, options.allowedUsers);
  if (routing.kind === "denied") {
    options.log(`[slack] ignored message from ${routing.user}`);
  } else if (routing.kind === "accepted") {
    options.log(
      `[slack] message channel=${routing.channel} thread=${routing.thread ?? "none"} user=${routing.user}`,
    );
  }
  return routing;
}

export interface SlackConnectionOptions {
  appToken: string;
  allowedUsers: readonly string[];
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
    });
  });

  await client.start();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
