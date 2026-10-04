import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetProviderContext } from "../../providers/credentials.ts";
import { configureSlack } from "../../providers/slack.ts";
import { type FetchCall, fakeFetch } from "../../providers/test-support.ts";
import { fetchSlackMessage } from "./fetch-message.ts";
import { postSlackMessage } from "./post-message.ts";

const CHANNEL = "C0C5EUZ7P9Q";
const BOT = {
  user_id: "U0C59SU5V29",
  bot_id: "B0C5JPZUW1J",
  user: "salims_jigs",
  team: "Jungle Scout",
};

// Recorded from the test channel, trimmed to what jigs reads.
const human = {
  user: "U01PW925E6N",
  type: "message",
  ts: "1790723478.961719",
  text: "<@U0C59SU5V29> which service owns checkout?",
  thread_ts: "1790723478.961719",
  reply_count: 2,
};
const botReply = {
  user: "U0C59SU5V29",
  type: "message",
  ts: "1790723480.100200",
  bot_id: "B0C5JPZUW1J",
  bot_profile: { id: "B0C5JPZUW1J", name: "Salim's jigs" },
  text: "Looking into it.",
  thread_ts: "1790723478.961719",
  parent_user_id: "U01PW925E6N",
};
const humanReply = {
  user: "U01PW925E6N",
  type: "message",
  ts: "1790723501.000300",
  text: "thanks!",
  thread_ts: "1790723478.961719",
  parent_user_id: "U01PW925E6N",
};
const tombstone = {
  subtype: "tombstone",
  text: "This message was deleted.",
  user: "USLACKBOT",
  hidden: true,
  type: "message",
  ts: "1790751556.382609",
  thread_ts: "1790751556.382609",
};
const usersInfo = {
  ok: true,
  user: {
    id: "U01PW925E6N",
    name: "salim",
    is_bot: false,
    profile: { display_name: "Salim", real_name: "Salim Hamed", email: "salim@example.com" },
  },
};

type Route = (params: URLSearchParams) => unknown;
let routes: Record<string, Route>;
let sent: FetchCall[];

const calls = (method: string) =>
  sent.filter((call) => call.url.pathname.endsWith(`/${method}`)).length;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  routes = {
    "auth.test": () => ({ ok: true, ...BOT }),
    "chat.getPermalink": (p) => ({
      ok: true,
      permalink: `https://junglescout.slack.com/archives/${p.get("channel")}/p${p.get("message_ts")?.replace(".", "")}`,
    }),
    "users.info": () => usersInfo,
  };
  const fake = fakeFetch((call) => {
    const method = call.url.pathname.slice(call.url.pathname.lastIndexOf("/") + 1);
    const route = routes[method];
    if (route === undefined) throw new Error(`unexpected ${method}`);
    return new Response(JSON.stringify(route(new URLSearchParams(call.body))));
  });
  sent = fake.calls;
  configureSlack({ fetch: fake.fetch, env: () => "xoxb-test" });
});
afterEach(() => {
  vi.restoreAllMocks();
  configureSlack({});
  resetProviderContext();
});

test("a snapshot is the message, its permalink and its replies in order, with each author", async () => {
  routes["conversations.replies"] = () => ({
    ok: true,
    messages: [human, botReply, humanReply],
  });
  const snapshot = await fetchSlackMessage({ channel: CHANNEL, ts: human.ts });
  const salim = {
    id: "U01PW925E6N",
    name: "Salim",
    email: "salim@example.com",
    bot: false,
    isOwnBot: false,
  };
  expect(snapshot).toEqual({
    gone: false,
    channel: CHANNEL,
    ts: human.ts,
    text: human.text,
    author: salim,
    permalink: `https://junglescout.slack.com/archives/${CHANNEL}/p1790723478961719`,
    replies: [
      {
        ts: botReply.ts,
        text: "Looking into it.",
        author: { id: "U0C59SU5V29", name: "Salim's jigs", bot: true, isOwnBot: true },
      },
      { ts: humanReply.ts, text: "thanks!", author: salim },
    ],
  });
  // Once per author per snapshot, and never for a bot.
  expect(calls("users.info")).toBe(1);
});

test.each([
  [
    "a Workflow Builder post reads as a bot, named by its profile",
    {
      subtype: "bot_message",
      bot_id: "B0DEPLOYS01",
      bot_profile: { id: "B0DEPLOYS01", name: "Deploy announcer" },
    },
    "B0DEPLOYS01",
  ],
  [
    "an app's post with a user reads as a bot, named by its profile",
    {
      user: "U0DEPLOYS01",
      bot_id: "B0DEPLOYS02",
      bot_profile: { id: "B0DEPLOYS02", name: "Deploy announcer" },
    },
    "U0DEPLOYS01",
  ],
])("%s", async (_name, fields, id) => {
  const announcement = {
    type: "message",
    ts: "1790723400.000100",
    text: "checkout-api v42 deployed to production",
    ...fields,
  };
  routes["conversations.replies"] = () => ({ ok: true, messages: [announcement] });
  const snapshot = await fetchSlackMessage({ channel: CHANNEL, ts: announcement.ts });
  expect(snapshot).toMatchObject({
    gone: false,
    text: announcement.text,
    author: { id, name: "Deploy announcer", bot: true, isOwnBot: false },
  });
  expect(calls("users.info")).toBe(0);
});

test("an author is looked up again on the next snapshot", async () => {
  routes["conversations.replies"] = () => ({ ok: true, messages: [human] });
  await fetchSlackMessage({ channel: CHANNEL, ts: human.ts });
  await fetchSlackMessage({ channel: CHANNEL, ts: human.ts });
  expect(calls("users.info")).toBe(2);
});

test.each([
  ["thread_not_found", () => ({ ok: false, error: "thread_not_found" })],
  ["message_not_found", () => ({ ok: false, error: "message_not_found" })],
  ["a tombstone", () => ({ ok: true, messages: [tombstone, humanReply] })],
])("a deleted message is gone (%s)", async (_, route) => {
  routes["conversations.replies"] = route;
  expect(await fetchSlackMessage({ channel: CHANNEL, ts: tombstone.ts })).toEqual({
    gone: true,
    channel: CHANNEL,
    ts: tombstone.ts,
  });
  expect(calls("users.info")).toBe(0);
});

test("a thread reply's ts fails at once, naming the top-level message's ts", async () => {
  // Slack answers a reply's ts with the reply alone.
  routes["conversations.replies"] = () => ({ ok: true, messages: [humanReply] });
  const error = await fetchSlackMessage({ channel: CHANNEL, ts: humanReply.ts }).catch((e) => e);
  expect(error).toMatchObject({
    fatal: true,
    message: `the Slack message ${CHANNEL} ${humanReply.ts} is a thread reply; pass its thread's top-level message ts, ${human.ts}`,
  });
  expect(calls("users.info")).toBe(0);
});

test("any other Slack error fails the snapshot, naming the missing scope", async () => {
  routes["conversations.replies"] = () => ({ ok: true, messages: [human] });
  routes["users.info"] = () => ({ ok: false, error: "missing_scope", needed: "users:read" });
  await expect(fetchSlackMessage({ channel: CHANNEL, ts: human.ts })).rejects.toThrow(
    "Slack users.info: missing_scope (needs users:read)",
  );
});

test("a post replies in the thread and returns the new message's ts", async () => {
  let sent: URLSearchParams | undefined;
  routes["chat.postMessage"] = (params) => {
    sent = params;
    return { ok: true, channel: CHANNEL, ts: "1790751555.052799" };
  };
  expect(await postSlackMessage({ channel: CHANNEL, text: "*Done*", threadTs: human.ts })).toBe(
    "1790751555.052799",
  );
  expect(Object.fromEntries(sent ?? [])).toEqual({
    channel: CHANNEL,
    text: "*Done*",
    thread_ts: human.ts,
  });
});
