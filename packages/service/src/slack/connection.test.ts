import { expect, test } from "vitest";
import {
  connectSlack,
  DispatchedMessages,
  handleSlackEnvelope,
  type SlackEnvelope,
  type SlackHandlerOptions,
  type SocketModeLike,
} from "./connection";
import type { ThreadRef } from "./dispatch";

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
  options: Partial<SlackHandlerOptions> = {},
) {
  const { envelope: env, acks } = envelope(event, over);
  const logs: string[] = [];
  const errors: string[] = [];
  const dispatched: ThreadRef[] = [];
  const routing = await handleSlackEnvelope(env, {
    allowedUsers: ALLOWED,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    dispatch: async (thread) => {
      dispatched.push(thread);
    },
    ...options,
  });
  return { routing, logs, errors, acks, dispatched };
}

const message = (over: Record<string, unknown> = {}) => ({
  type: "message",
  user: "U0ALLOWED",
  channel: "C0RUNS",
  ts: "1757000000.000100",
  text: "ship it",
  ...over,
});

test("an allowed message is acked, logged and answered in the thread it came from", async () => {
  const { routing, logs, acks, dispatched } = await handle(
    message({ thread_ts: "1757000000.000001" }),
  );
  expect(routing).toEqual({
    kind: "accepted",
    channel: "C0RUNS",
    user: "U0ALLOWED",
    ts: "1757000000.000100",
    text: "ship it",
    thread: "1757000000.000001",
  });
  expect(acks).toHaveLength(1);
  expect(logs).toEqual([
    "[slack] message channel=C0RUNS thread=1757000000.000001 user=U0ALLOWED",
  ]);
  expect(dispatched).toEqual([
    {
      channel: "C0RUNS",
      threadTs: "1757000000.000001",
      message: {
        ts: "1757000000.000100",
        text: "ship it",
        user: "U0ALLOWED",
      },
    },
  ]);
});

test("a top-level message opens a thread under itself", async () => {
  const { logs, dispatched } = await handle(message());
  expect(logs).toEqual([
    "[slack] message channel=C0RUNS thread=none user=U0ALLOWED",
  ]);
  expect(dispatched[0]).toMatchObject({
    channel: "C0RUNS",
    threadTs: "1757000000.000100",
  });
});

test("a message from outside the allowlist reaches no dispatcher at all", async () => {
  const { dispatched } = await handle(message({ user: "U0STRANGER" }));
  expect(dispatched).toEqual([]);
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
    // Nothing to open a thread under, so nothing to answer in.
    [message({ ts: undefined }), {}],
    [message({ channel: undefined }), {}],
  ] as [Record<string, unknown> | null, Partial<SlackEnvelope>][]) {
    const { routing, logs } = await handle(event, over);
    expect(routing).toEqual({ kind: "ignored" });
    expect(logs).toEqual([]);
  }
});

test("a failed ack leaves the message to Slack's redelivery rather than answering twice", async () => {
  // An unacked envelope is one Slack is already re-sending. Answering this
  // copy too is how one question gets two replies.
  const { envelope: env } = envelope(message());
  const logs: string[] = [];
  const errors: string[] = [];
  const dispatched: ThreadRef[] = [];
  const routing = await handleSlackEnvelope(
    { ...env, ack: () => Promise.reject(new Error("socket closed")) },
    {
      allowedUsers: ALLOWED,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
      dispatch: async (thread) => {
        dispatched.push(thread);
      },
    },
  );
  expect(routing).toEqual({ kind: "ignored" });
  expect(dispatched).toEqual([]);
  expect(errors[0]).toContain("socket closed");
  expect(errors[0]).toContain("redelivery");
  expect(logs).toEqual([]);
});

test("a redelivery of a message already dispatched is dropped, not answered again", async () => {
  const dispatched = new DispatchedMessages();
  const first = await handle(message(), {}, { dispatched });
  expect(first.dispatched).toHaveLength(1);

  const again = await handle(message(), { retry_num: 1 }, { dispatched });
  expect(again.routing.kind).toBe("accepted");
  expect(again.dispatched).toEqual([]);
  expect(again.logs[0]).toContain("redelivery attempt=1");
  expect(again.logs.at(-1)).toContain("already answered");
});

test("a different message in the same thread is not mistaken for a redelivery", async () => {
  const dispatched = new DispatchedMessages();
  await handle(message(), {}, { dispatched });
  const second = await handle(
    message({ ts: "1757000000.000200" }),
    {},
    { dispatched },
  );
  expect(second.dispatched).toHaveLength(1);
});

test("the seen set is bounded, so a long-lived service does not grow one entry per message", () => {
  const dispatched = new DispatchedMessages();
  for (let i = 0; i < 600; i += 1) {
    expect(dispatched.claim("C0RUNS", String(i))).toBe(true);
  }
  // The oldest have been evicted — claimable again, which is the price of a
  // bounded set and cheaper than the leak.
  expect(dispatched.claim("C0RUNS", "0")).toBe(true);
  expect(dispatched.claim("C0RUNS", "599")).toBe(false);
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
