// The factory's one Socket Mode connection to Slack. It hands on channel
// message events and nothing else; what a message means (a trigger's
// occurrence, a thread's reply) is its listener's business. Polling stays
// underneath: Slack redelivers an unacked event for about six minutes and
// then drops it.

import { JigsError } from "../errors.ts";
import { type SlackMessage, slackOpenConnection } from "../providers/slack.ts";

/** A channel message event as Socket Mode delivers it: the message, and where it was posted. */
export interface SlackMessageEvent extends SlackMessage {
  type: "message";
  channel: string;
  /** `channel` or `group` for a public or private channel, `im` or `mpim` for a direct message. */
  channel_type?: string;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
const REFRESH_REASONS = new Set(["warning", "refresh_requested"]);

/** The part of a WebSocket the connection uses. */
export interface SlackSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export interface SlackSocketDeps {
  onMessage: (event: SlackMessageEvent) => unknown;
  /** Returns a fresh connection URL from `apps.connections.open`. */
  open?: () => Promise<string>;
  connect?: (url: string) => SlackSocketLike;
  log?: (line: string) => void;
}

export interface SlackSocket {
  /** Close the connection and open no other. */
  stop(): void;
}

interface Envelope {
  envelope_id?: unknown;
  type?: unknown;
  reason?: unknown;
  payload?: { event?: unknown };
}

function isMessageEvent(event: unknown): event is SlackMessageEvent {
  const candidate = event as Partial<SlackMessageEvent> | null | undefined;
  return (
    candidate?.type === "message" &&
    typeof candidate.channel === "string" &&
    typeof candidate.ts === "string"
  );
}

/**
 * Hold a Socket Mode connection until stopped, reconnecting when Slack asks
 * to and, with backoff, when the connection drops or cannot be opened.
 */
export function startSlackSocket(deps: SlackSocketDeps): SlackSocket {
  const open = deps.open ?? slackOpenConnection;
  const connectTo = deps.connect ?? ((url: string): SlackSocketLike => new WebSocket(url));
  const log = deps.log ?? console.log;

  let stopped = false;
  let current: SlackSocketLike | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const retry = () => {
    if (stopped) return;
    const ms = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** failures);
    failures += 1;
    log(`[slack] reconnecting in ${ms / 1000}s`);
    retryTimer = setTimeout(() => void connect(), ms);
    retryTimer.unref?.();
  };

  const deliver = async (event: SlackMessageEvent) => {
    try {
      await deps.onMessage(event);
    } catch (error) {
      log(`[slack] could not handle message ${event.channel}:${event.ts}: ${String(error)}`);
    }
  };

  async function connect(): Promise<void> {
    if (stopped) return;
    let socket: SlackSocketLike;
    try {
      const url = await open();
      if (stopped) return;
      socket = connectTo(url);
    } catch (error) {
      // Only the name: a WebSocket's error can quote the connection URL, which
      // carries a ticket.
      const why = error instanceof JigsError ? error.message : (error as Error)?.name;
      log(`[slack] could not open a Socket Mode connection: ${why}`);
      return retry();
    }
    current = socket;
    let ended = false;
    const end = (why: string, next: () => void) => {
      if (ended) return;
      ended = true;
      if (current === socket) current = undefined;
      socket.close();
      log(`[slack] Socket Mode connection ${why}`);
      next();
    };

    socket.addEventListener("message", ({ data }) => {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(data)) as Envelope;
      } catch {
        return;
      }
      // Before anything else: an envelope Slack does not see acked within
      // seconds is sent again.
      if (typeof envelope.envelope_id === "string")
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      if (envelope.type === "hello") {
        failures = 0;
        log("[slack] Socket Mode connected");
      } else if (envelope.type === "disconnect") {
        const reason = String(envelope.reason);
        // Any other reason, such as Socket Mode switched off, would refuse a
        // reconnect at once too.
        if (REFRESH_REASONS.has(reason))
          end(`refreshed by Slack (${reason})`, () => void connect());
        else end(`ended by Slack (${reason})`, retry);
      } else if (envelope.type === "events_api") {
        const event = envelope.payload?.event;
        if (isMessageEvent(event)) void deliver(event);
      }
    });
    socket.addEventListener("close", () => end("closed", retry));
    socket.addEventListener("error", () => end("failed", retry));
  }

  void connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      current?.close();
      current = undefined;
    },
  };
}
