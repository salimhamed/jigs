import { expect, test } from "vitest";
import { type SlackMessageEvent, type SlackSocketLike, startSlackSocket } from "./slack-socket.ts";

// Recorded from Socket Mode on the test app, trimmed to what jigs reads.
const HELLO = {
  type: "hello",
  num_connections: 1,
  debug_info: { host: "applink-1", approximate_connection_time: 18060 },
  connection_info: { app_id: "A0C5JPZ7X2K" },
};
const MESSAGE_EVENT = {
  type: "message",
  user: "U01PW925E6N",
  ts: "1790723463.853679",
  text: "Real prototype, message 1",
  team: "T0A7SCMC5",
  channel: "C0C5EUZ7P9Q",
  event_ts: "1790723463.853679",
  channel_type: "channel",
};
const envelope = (id: string, extra: object = {}) => ({
  envelope_id: id,
  type: "events_api",
  accepts_response_payload: false,
  retry_attempt: 0,
  retry_reason: "",
  payload: {
    type: "event_callback",
    team_id: "T0A7SCMC5",
    event: MESSAGE_EVENT,
    event_id: "Ev0C5Q1AB2CD",
    event_time: 1790723463,
  },
  ...extra,
});
const DISCONNECT = {
  type: "disconnect",
  reason: "refresh_requested",
  debug_info: { host: "applink-1" },
};

class FakeSocket implements SlackSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  readonly url: string;
  private readonly journal: string[];
  constructor(url: string, journal: string[]) {
    this.url = url;
    this.journal = journal;
  }
  send(data: string) {
    this.sent.push(data);
    this.journal.push(`ack ${JSON.parse(data).envelope_id}`);
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(
  opts: { failOpens?: number; onMessage?: (event: SlackMessageEvent) => unknown } = {},
) {
  const journal: string[] = [];
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fire: () => void; ms: number; cancelled: boolean }> = [];
  const delivered: SlackMessageEvent[] = [];
  let opens = 0;
  const socket = startSlackSocket({
    onMessage:
      opts.onMessage ??
      ((event) => {
        journal.push(`deliver ${event.ts}`);
        delivered.push(event);
      }),
    open: async () => {
      opens += 1;
      if (opens <= (opts.failOpens ?? 0))
        throw new Error("Slack apps.connections.open: ratelimited");
      return `wss://wss-primary.slack.com/link/?ticket=${opens}`;
    },
    connect: (url) => {
      const fake = new FakeSocket(url, journal);
      sockets.push(fake);
      return fake;
    },
    setTimer: (fire, ms) => {
      const timer = { fire, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    log: () => {},
  });
  return { socket, journal, sockets, timers, delivered, opens: () => opens };
}

test("each envelope is acked before its event is handed on", async () => {
  const { sockets, journal, delivered } = harness();
  await settle();
  const [socket] = sockets;
  socket?.emit("message", HELLO);
  socket?.emit("message", envelope("env-1"));
  await settle();
  expect(journal).toEqual(["ack env-1", "deliver 1790723463.853679"]);
  expect(delivered).toEqual([MESSAGE_EVENT]);
});

test("a retry envelope is acked and handed on again; dedupe is the listener's", async () => {
  const { sockets, journal } = harness();
  await settle();
  sockets[0]?.emit("message", envelope("env-1"));
  sockets[0]?.emit("message", envelope("env-2", { retry_attempt: 3, retry_reason: "timeout" }));
  await settle();
  expect(journal).toEqual([
    "ack env-1",
    "deliver 1790723463.853679",
    "ack env-2",
    "deliver 1790723463.853679",
  ]);
});

test("a non-message event is acked and not handed on", async () => {
  const { sockets, journal, delivered } = harness();
  await settle();
  const reaction = envelope("env-3", {
    payload: { type: "event_callback", event: { type: "reaction_added", reaction: "eyes" } },
  });
  sockets[0]?.emit("message", reaction);
  sockets[0]?.emit("message", "not json");
  await settle();
  expect(journal).toEqual(["ack env-3"]);
  expect(delivered).toEqual([]);
});

test("a listener that throws is logged, and the next event still arrives", async () => {
  let calls = 0;
  const { sockets } = harness({
    onMessage: () => {
      calls += 1;
      if (calls === 1) throw new Error("registry down");
    },
  });
  await settle();
  sockets[0]?.emit("message", envelope("env-1"));
  sockets[0]?.emit("message", envelope("env-2"));
  await settle();
  expect(calls).toBe(2);
});

test("a disconnect from Slack reconnects at once on a fresh URL", async () => {
  const { sockets, timers, opens } = harness();
  await settle();
  sockets[0]?.emit("message", { ...DISCONNECT, reason: "warning" });
  await settle();
  expect(sockets[0]?.closed).toBe(true);
  expect(opens()).toBe(2);
  expect(sockets[1]?.url).toContain("ticket=2");
  // The old socket's own close event after that opens nothing more.
  sockets[0]?.emit("close");
  sockets[1]?.emit("message", DISCONNECT);
  await settle();
  expect(opens()).toBe(3);
  expect(timers).toEqual([]);
});

test("a dropped connection reconnects with backoff, reset once Slack says hello", async () => {
  const { sockets, timers, opens } = harness({ failOpens: 0 });
  await settle();
  sockets[0]?.emit("close");
  expect(timers.map((t) => t.ms)).toEqual([1_000]);
  timers[0]?.fire();
  await settle();
  sockets[1]?.emit("error");
  expect(timers.map((t) => t.ms)).toEqual([1_000, 2_000]);
  timers[1]?.fire();
  await settle();
  sockets[2]?.emit("message", HELLO);
  sockets[2]?.emit("close");
  expect(timers.map((t) => t.ms)).toEqual([1_000, 2_000, 1_000]);
  expect(opens()).toBe(3);
});

test("a connection that cannot be opened is retried with growing waits, capped at a minute", async () => {
  const { timers, opens } = harness({ failOpens: 10 });
  for (let i = 0; i < 8; i += 1) {
    await settle();
    timers.at(-1)?.fire();
  }
  await settle();
  expect(timers.map((t) => t.ms)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
  ]);
  expect(opens()).toBe(9);
});

test("stop closes the connection, opens no other, and waits for events in hand", async () => {
  let release: () => void = () => {};
  const handled: string[] = [];
  const { socket, sockets, timers, opens } = harness({
    onMessage: (event) =>
      new Promise<void>((resolve) => {
        release = () => {
          handled.push(event.ts);
          resolve();
        };
      }),
  });
  await settle();
  sockets[0]?.emit("message", envelope("env-1"));
  let stopped = false;
  const stopping = socket.stop().then(() => {
    stopped = true;
  });
  expect(sockets[0]?.closed).toBe(true);
  sockets[0]?.emit("close");
  await settle();
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(handled).toEqual(["1790723463.853679"]);
  expect(timers).toEqual([]);
  expect(opens()).toBe(1);
});
