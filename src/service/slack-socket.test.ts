import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SlackApiError } from "../providers/slack.ts";
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

function harness(
  opts: {
    failOpens?: number;
    connect?: (url: string) => SlackSocketLike;
    onMessage?: (event: SlackMessageEvent) => unknown;
  } = {},
) {
  const journal: string[] = [];
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
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
        throw new SlackApiError("apps.connections.open", "ratelimited");
      return `wss://wss-primary.slack.com/link/?ticket=${opens}`;
    },
    connect:
      opts.connect ??
      ((url) => {
        const fake = new FakeSocket(url, journal);
        sockets.push(fake);
        return fake;
      }),
    log: (line) => logs.push(line),
  });
  const waits = () =>
    logs.flatMap((line) => /reconnecting in (\d+)s/.exec(line)?.[1] ?? []).map(Number);
  return { socket, journal, sockets, logs, waits, delivered, opens: () => opens };
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
  const { sockets, logs } = harness({
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
  expect(logs).toContain(
    "[slack] could not handle message C0C5EUZ7P9Q:1790723463.853679: Error: registry down",
  );
});

test.each(["warning", "refresh_requested"])(
  "a %s disconnect reconnects at once on a fresh URL",
  async (reason) => {
    const { sockets, waits, opens } = harness();
    await settle();
    sockets[0]?.emit("message", { ...DISCONNECT, reason });
    await settle();
    expect(sockets[0]?.closed).toBe(true);
    expect(opens()).toBe(2);
    expect(sockets[1]?.url).toContain("ticket=2");
    // The old socket's own close event after that opens nothing more.
    sockets[0]?.emit("close");
    await vi.runAllTimersAsync();
    expect(opens()).toBe(2);
    expect(waits()).toEqual([]);
  },
);

test("any other disconnect reason reconnects with backoff, like a close", async () => {
  const { sockets, waits, opens } = harness();
  await settle();
  sockets[0]?.emit("message", { ...DISCONNECT, reason: "link_disabled" });
  await settle();
  expect(sockets[0]?.closed).toBe(true);
  expect(opens()).toBe(1);
  expect(waits()).toEqual([1]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(opens()).toBe(2);
});

test("too_many_websockets names a shared Slack app as the likely cause, then retries as usual", async () => {
  const { sockets, logs, waits, opens } = harness();
  await settle();
  sockets[0]?.emit("message", { ...DISCONNECT, reason: "too_many_websockets" });
  await settle();
  expect(logs).toContain(
    "[slack] Slack says this app has too many Socket Mode connections (too_many_websockets): another process, on this machine or elsewhere, is likely holding connections for the same Slack app, and Slack splits the app's events between them. Each factory needs its own Slack app",
  );
  expect(logs).toContain("[slack] Socket Mode connection ended by Slack (too_many_websockets)");
  expect(waits()).toEqual([1]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(opens()).toBe(2);
});

test("a dropped connection reconnects with backoff, reset once a connection stays up 30s", async () => {
  const { sockets, waits, opens } = harness();
  await settle();
  sockets[0]?.emit("close");
  await vi.advanceTimersByTimeAsync(1_000);
  sockets[1]?.emit("error");
  await vi.advanceTimersByTimeAsync(2_000);
  sockets[2]?.emit("message", HELLO);
  await vi.advanceTimersByTimeAsync(30_000);
  sockets[2]?.emit("close");
  expect(waits()).toEqual([1, 2, 1]);
  expect(opens()).toBe(3);
});

test("a connection that says hello and then drops keeps backing off", async () => {
  const { sockets, waits } = harness();
  await settle();
  for (const [i, wait] of [1, 2, 4, 8].entries()) {
    sockets[i]?.emit("message", HELLO);
    await vi.advanceTimersByTimeAsync(500);
    sockets[i]?.emit("close");
    await vi.advanceTimersByTimeAsync(wait * 1_000);
  }
  expect(waits()).toEqual([1, 2, 4, 8]);
});

test("a connection that cannot be opened is retried with growing waits, capped at a minute", async () => {
  const { waits, opens } = harness({ failOpens: 8 });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(waits()).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  expect(opens()).toBe(9);
});

test("a socket that throws on construction is retried, and its error never reaches the log", async () => {
  let attempts = 0;
  const journal: string[] = [];
  const { logs, opens } = harness({
    connect: (url) => {
      attempts += 1;
      if (attempts === 1) throw new SyntaxError(`Invalid URL: ${url}`);
      return new FakeSocket(url, journal);
    },
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(opens()).toBe(2);
  expect(logs.join("\n")).not.toContain("ticket=");
  expect(logs).toContain("[slack] could not open a Socket Mode connection: SyntaxError");
});

test("stop closes the connection and opens no other", async () => {
  const { socket, sockets, opens } = harness();
  await settle();
  socket.stop();
  expect(sockets[0]?.closed).toBe(true);
  sockets[0]?.emit("close");
  await vi.runAllTimersAsync();
  expect(opens()).toBe(1);
});
