import { expect, test } from "vitest";
import {
  connectSlack,
  handleSlackEnvelope,
  type SlackEnvelope,
  type SocketModeLike,
} from "./connection";

const ALLOWED = ["U0ALLOWED"];

function envelope(
  event: Record<string, unknown> | null,
  over: Partial<SlackEnvelope> = {},
): { envelope: SlackEnvelope; acks: unknown[] } {
  const acks: unknown[] = [];
  return {
    envelope: {
      ack: async (response?: unknown) => {
        acks.push(response ?? null);
      },
      envelope_id: "b9c1e1d0-0000-4000-8000-000000000000",
      type: "events_api",
      body: event === null ? {} : { event },
      ...over,
    },
    acks,
  };
}

async function handle(
  event: Record<string, unknown> | null,
  over: Partial<SlackEnvelope> = {},
) {
  const { envelope: env, acks } = envelope(event, over);
  const logs: string[] = [];
  const errors: string[] = [];
  const routing = await handleSlackEnvelope(env, {
    allowedUsers: ALLOWED,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  return { routing, logs, errors, acks };
}

const message = (over: Record<string, unknown> = {}) => ({
  type: "message",
  user: "U0ALLOWED",
  channel: "C0RUNS",
  ts: "1757000000.000100",
  text: "ship it",
  ...over,
});

test("an allowed message is acked and logged with its channel, thread and user", async () => {
  const { routing, logs, acks } = await handle(
    message({ thread_ts: "1757000000.000001" }),
  );
  expect(routing).toEqual({
    kind: "accepted",
    channel: "C0RUNS",
    user: "U0ALLOWED",
    thread: "1757000000.000001",
  });
  expect(acks).toHaveLength(1);
  expect(logs).toEqual([
    "[slack] message channel=C0RUNS thread=1757000000.000001 user=U0ALLOWED",
  ]);
});

test("a top-level message reports no thread rather than an empty one", async () => {
  const { logs } = await handle(message());
  expect(logs).toEqual([
    "[slack] message channel=C0RUNS thread=none user=U0ALLOWED",
  ]);
});

test("an app_mention envelope is dropped — the message.* copy of it is the one that counts", async () => {
  // Slack delivers a channel mention as both; routing both would ack and
  // answer one utterance twice.
  const { routing, logs } = await handle(message({ type: "app_mention" }));
  expect(routing).toEqual({ kind: "ignored" });
  expect(logs).toEqual([]);
});

test("a message from outside the allowlist is named in the log and dropped", async () => {
  const { routing, logs, acks } = await handle(message({ user: "U0STRANGER" }));
  expect(routing).toEqual({ kind: "denied", user: "U0STRANGER" });
  expect(logs).toEqual(["[slack] ignored message from U0STRANGER"]);
  // Acked all the same: an unacknowledged envelope is one Slack redelivers.
  expect(acks).toHaveLength(1);
});

test("this app's own posts and the message subtypes are dropped silently", async () => {
  for (const event of [
    message({ bot_id: "B0JIGS", user: undefined }),
    message({ subtype: "message_changed" }),
    message({ subtype: "channel_join" }),
  ]) {
    const { routing, logs } = await handle(event);
    expect(routing).toEqual({ kind: "ignored" });
    expect(logs).toEqual([]);
  }
});

test("an envelope that is not an addressable event is dropped silently", async () => {
  for (const [event, over] of [
    [message({ type: "reaction_added" }), {}],
    [null, {}],
    [message(), { type: "slash_commands" }],
    [message({ user: undefined }), {}],
  ] as [Record<string, unknown> | null, Partial<SlackEnvelope>][]) {
    const { routing, logs } = await handle(event, over);
    expect(routing).toEqual({ kind: "ignored" });
    expect(logs).toEqual([]);
  }
});

test("a failed ack is reported and the event is still routed", async () => {
  const { envelope: env } = envelope(message());
  const logs: string[] = [];
  const errors: string[] = [];
  const routing = await handleSlackEnvelope(
    { ...env, ack: () => Promise.reject(new Error("socket closed")) },
    {
      allowedUsers: ALLOWED,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  );
  expect(routing.kind).toBe("accepted");
  expect(errors[0]).toContain("socket closed");
  expect(logs).toHaveLength(1);
});

function fakeClient(start: () => Promise<unknown> = async () => ({})) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const client: SocketModeLike = {
    start,
    on: (event, listener) => listeners.set(event, listener),
  };
  return { client, listeners };
}

test("connect subscribes once to the catch-all, so an envelope is acked once", async () => {
  const { client, listeners } = fakeClient();
  const logs: string[] = [];
  await connectSlack({
    appToken: "xapp-not-used",
    allowedUsers: ALLOWED,
    client,
    log: (line) => logs.push(line),
    error: () => {},
  });
  expect([...listeners.keys()]).toEqual([
    "connected",
    "disconnected",
    "error",
    "slack_event",
  ]);

  const { envelope: env, acks } = envelope(message());
  listeners.get("slack_event")?.(env);
  await Promise.resolve();
  expect(acks).toHaveLength(1);
});

test("the socket's lifecycle is what the operator sees of it", async () => {
  const { client, listeners } = fakeClient();
  const logs: string[] = [];
  const errors: string[] = [];
  await connectSlack({
    appToken: "xapp-not-used",
    allowedUsers: ALLOWED,
    client,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  listeners.get("connected")?.();
  listeners.get("disconnected")?.();
  listeners.get("error")?.(new Error("websocket closed unexpectedly"));
  expect(logs).toEqual(["[slack] connected", "[slack] disconnected"]);
  expect(errors).toEqual([
    "[slack] socket error: websocket closed unexpectedly",
  ]);
});

test("a start Slack refuses rejects rather than leaving a dead connection", async () => {
  const { client } = fakeClient(() =>
    Promise.reject(new Error("invalid_auth")),
  );
  await expect(
    connectSlack({
      appToken: "xapp-wrong",
      allowedUsers: ALLOWED,
      client,
      log: () => {},
      error: () => {},
    }),
  ).rejects.toThrow("invalid_auth");
});
