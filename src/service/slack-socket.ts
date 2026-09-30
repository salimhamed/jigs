// The factory's one Socket Mode connection to Slack. It hands on channel
// message events and nothing else; what a message means (a trigger's
// occurrence, a thread's reply) is its listener's business. Polling stays
// underneath: Slack redelivers an unacked event for about six minutes and
// then drops it.

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
  /** Schedules one call and returns its canceller. */
  setTimer?: (fire: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

export interface SlackSocket {
  /** Close the connection, open no other, and settle once the events in hand are. */
  stop(): Promise<void>;
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
  const setTimer =
    deps.setTimer ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });

  let stopped = false;
  let current: SlackSocketLike | undefined;
  let cancelRetry: (() => void) | undefined;
  let failures = 0;
  const inFlight = new Set<Promise<void>>();

  const retry = () => {
    if (stopped) return;
    const ms = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** failures);
    failures += 1;
    log(`[slack] reconnecting in ${ms / 1000}s`);
    cancelRetry = setTimer(() => void connect(), ms);
  };

  const deliver = (event: SlackMessageEvent) => {
    const delivery = (async () => {
      try {
        await deps.onMessage(event);
      } catch (error) {
        log(`[slack] could not handle message ${event.channel}:${event.ts}: ${String(error)}`);
      }
    })();
    inFlight.add(delivery);
    void delivery.finally(() => inFlight.delete(delivery));
  };

  async function connect(): Promise<void> {
    let url: string;
    try {
      url = await open();
    } catch (error) {
      log(`[slack] could not open a Socket Mode connection: ${String(error)}`);
      return retry();
    }
    if (stopped) return;
    const socket = connectTo(url);
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
        end(`refreshed by Slack (${String(envelope.reason)})`, () => {
          if (!stopped) void connect();
        });
      } else if (envelope.type === "events_api") {
        const event = envelope.payload?.event;
        if (isMessageEvent(event)) deliver(event);
      }
    });
    socket.addEventListener("close", () => end("closed", retry));
    socket.addEventListener("error", () => end("failed", retry));
  }

  void connect();
  return {
    async stop() {
      stopped = true;
      cancelRetry?.();
      current?.close();
      current = undefined;
      await Promise.all(inFlight);
    },
  };
}
