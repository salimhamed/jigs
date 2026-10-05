import { beforeEach, expect, test, vi } from "vitest";
import * as slackApi from "../providers/slack.ts";
import { slack } from "../workflow/slack/sources.ts";
import { SOURCES } from "./event-triggers/sources.ts";
import { slackSources } from "./slack-sources.ts";

const BOT = {
  userId: "U0C59SU5V29",
  name: "salims_jigs",
  team: "T0A7SCMC5",
  scopes: [],
};
const CHANNEL = "C0C5EUZ7P9Q";
const HUMAN = "U01PW925E6N";

// Recorded from the test channel's history, trimmed to what jigs reads.
const TOP_LEVEL = {
  type: "message",
  user: HUMAN,
  ts: "1790723244.335019",
  text: "Hello, this is my first test message",
};
const THREAD_PARENT = {
  type: "message",
  user: HUMAN,
  ts: "1790723267.882559",
  thread_ts: "1790723267.882559",
  reply_count: 2,
  text: "Hello jigs! This is my second test message.",
};
const MENTION = {
  type: "message",
  user: HUMAN,
  ts: "1790723299.105659",
  text: "<@U0C59SU5V29> how are you doing today?",
};
const THREAD_REPLY = {
  type: "message",
  user: HUMAN,
  ts: "1790723359.716379",
  thread_ts: "1790723299.105659",
  text: "a reply in the thread",
};
const JOIN = {
  type: "message",
  subtype: "channel_join",
  user: HUMAN,
  ts: "1790716793.784569",
  text: "<@U01PW925E6N> has joined the channel",
};
const OWN_POST = {
  type: "message",
  user: BOT.userId,
  bot_id: "B0C5JPZUW1J",
  ts: "1790723386.003159",
  text: "posted by the factory",
};

// Written by hand from Slack's message event reference.
const OTHER_BOT = {
  type: "message",
  subtype: "bot_message",
  bot_id: "B0DEPLOYS01",
  bot_profile: { name: "Deploy announcer" },
  ts: "1790723400.000100",
  text: "checkout-api v42 deployed to production",
};
const APP_POST = {
  type: "message",
  user: "U0DEPLOYS01",
  bot_id: "B0DEPLOYS02",
  bot_profile: { name: "Release bot" },
  ts: "1790723405.000150",
  text: "release 42 is out",
};
const ME_POST = {
  type: "message",
  subtype: "me_message",
  user: HUMAN,
  ts: "1790723415.000250",
  text: "is deploying checkout",
};
const FILE_POST = {
  type: "message",
  subtype: "file_share",
  user: HUMAN,
  ts: "1790723410.000200",
  text: "here is the stack trace",
};
const BROADCAST = {
  type: "message",
  subtype: "thread_broadcast",
  user: HUMAN,
  ts: "1790723420.000300",
  thread_ts: MENTION.ts,
  text: "a reply also sent to the channel",
};
const EDIT = {
  type: "message",
  subtype: "message_changed",
  ts: "1790723430.000400",
  message: { ...TOP_LEVEL, text: "edited" },
};
const DELETE = {
  type: "message",
  subtype: "message_deleted",
  ts: "1790723440.000500",
  deleted_ts: TOP_LEVEL.ts,
};
const HISTORY_PAGE = [
  DELETE,
  EDIT,
  BROADCAST,
  ME_POST,
  FILE_POST,
  APP_POST,
  OTHER_BOT,
  MENTION,
  THREAD_REPLY,
  THREAD_PARENT,
  OWN_POST,
  TOP_LEVEL,
  JOIN,
];

// An Events API body as the hub sends it, its event recorded from the test channel.
const pushed = (message: object, channelType = "channel", channel = CHANNEL) => ({
  type: "event_callback",
  api_app_id: "A0C5JPZUW1J",
  team_id: "T0A7SCMC5",
  event_id: "Ev0C5JPZUW1J",
  event: {
    ...message,
    channel,
    channel_type: channelType,
    event_ts: (message as { ts: string }).ts,
    team: "T0A7SCMC5",
  },
});

const params = { channels: [CHANNEL] };
const messages = SOURCES["slack.messages"];
const mentions = SOURCES["slack.mentions"];
if (messages === undefined || mentions === undefined) throw new Error("slack sources missing");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(slackApi, "slackBot").mockResolvedValue(BOT);
});

test("the descriptors a factory writes name the registered kinds", () => {
  expect(slack.messages(params)).toEqual({ kind: "slack.messages", params });
  expect(slack.mentions(params)).toEqual({ kind: "slack.mentions", params });
});

test("channels are IDs of public or private channels, never names or DMs", () => {
  expect(messages.params.safeParse(params).success).toBe(true);
  expect(messages.params.safeParse({ channels: ["G012AB3CD"] }).success).toBe(true);
  for (const channels of [[], ["#jigs-sandbox"], ["D0123ABCD"]])
    expect(messages.params.safeParse({ channels }).success).toBe(false);
});

test("messages polls history from the floor on a first poll and keeps new top-level posts", async () => {
  const history = vi.spyOn(slackApi, "slackHistory").mockResolvedValue(HISTORY_PAGE);
  const floor = new Date(1790716000_000);
  const { occurrences: found } = await messages.poll(params, undefined, floor);
  expect(history).toHaveBeenCalledExactlyOnceWith(CHANNEL, { oldest: "1790716000.000000" });
  expect(found).toEqual(
    [ME_POST, FILE_POST, APP_POST, OTHER_BOT, MENTION, THREAD_PARENT, TOP_LEVEL].map((m) => ({
      inputs: { channel: CHANNEL, ts: m.ts },
      at: new Date(Number(m.ts) * 1000),
    })),
  );
});

test("mentions keeps only the top-level messages that tag the bot", async () => {
  vi.spyOn(slackApi, "slackHistory").mockResolvedValue(HISTORY_PAGE);
  const { occurrences: found } = await mentions.poll(params, undefined, new Date(0));
  expect(found.map((seen) => seen.inputs)).toEqual([{ channel: CHANNEL, ts: MENTION.ts }]);
});

test("each channel reads from its own cursor, clamped to the floor, and moves it to the poll's start", async () => {
  const pollAt = new Date(1790723500_000);
  const source = slackSources(() => pollAt)["slack.messages"];
  const history = vi.spyOn(slackApi, "slackHistory").mockResolvedValue([]);
  const { cursor } = await source.poll(
    { channels: ["C0AHEAD01", "C0BEHIND1", "C0NEW0001"] },
    { C0AHEAD01: "1790723400.000100", C0BEHIND1: "1790000000.000000", C0GONE001: "1.000000" },
    new Date(1790716000_000),
  );
  expect(history.mock.calls).toEqual([
    ["C0AHEAD01", { oldest: "1790723400.000100" }],
    ["C0BEHIND1", { oldest: "1790716000.000000" }],
    ["C0NEW0001", { oldest: "1790716000.000000" }],
  ]);
  // A channel no longer watched is dropped.
  expect(cursor).toEqual({
    C0AHEAD01: "1790723500.000000",
    C0BEHIND1: "1790723500.000000",
    C0NEW0001: "1790723500.000000",
  });
});

test("a failing channel is logged with its repair and keeps its cursor, and the rest are read", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const source = slackSources(() => new Date(1790723500_000))["slack.messages"];
  const history = vi
    .spyOn(slackApi, "slackHistory")
    .mockRejectedValueOnce(new slackApi.SlackApiError("conversations.history", "not_in_channel"))
    .mockRejectedValueOnce(new slackApi.SlackApiError("conversations.history", "ratelimited"))
    .mockResolvedValueOnce([TOP_LEVEL]);
  const polled = await source.poll(
    { channels: ["C0SECOND1", "C0THIRD01", CHANNEL] },
    { C0SECOND1: "1790716000.000000" },
    new Date(0),
  );
  expect(history).toHaveBeenCalledTimes(3);
  expect(polled).toEqual({
    occurrences: [{ inputs: { channel: CHANNEL, ts: TOP_LEVEL.ts }, at: expect.any(Date) }],
    // The channel with no cursor yet stays without one, so it reads from the floor again.
    cursor: { C0SECOND1: "1790716000.000000", [CHANNEL]: "1790723500.000000" },
  });
  const lines = log.mock.calls.map(([line]) => String(line));
  expect(lines[0]).toBe(
    "[slack] could not poll channel C0SECOND1: Slack conversations.history: not_in_channel",
  );
  expect(lines[1]).toContain(`invite @${BOT.name} to C0SECOND1 again`);
});

test("a cursor is a map of channel to Slack timestamp", () => {
  expect(messages.cursor.safeParse({ [CHANNEL]: TOP_LEVEL.ts }).success).toBe(true);
  for (const bad of ["1790723244.335019", { [CHANNEL]: 1790723244 }, null])
    expect(messages.cursor.safeParse(bad).success).toBe(false);
});

test("a pushed message is the same occurrence its poll finds", async () => {
  vi.spyOn(slackApi, "slackHistory").mockResolvedValue([TOP_LEVEL]);
  const {
    occurrences: [polled],
  } = await messages.poll(params, undefined, new Date(0));
  const push = await messages.fromPush(params, pushed(TOP_LEVEL));
  expect(push).toEqual(polled);
  expect(messages.occurrence(push?.inputs ?? {})).toBe(`${CHANNEL}:${TOP_LEVEL.ts}`);
  expect(messages.describe(push?.inputs ?? {})).toBe(`slack ${CHANNEL} ${TOP_LEVEL.ts}`);
});

test.each([
  ["a thread reply", pushed(THREAD_REPLY)],
  ["a channel join", pushed(JOIN)],
  ["a thread broadcast", pushed(BROADCAST)],
  ["an edit", pushed(EDIT)],
  ["a delete", pushed(DELETE)],
  ["the bot's own post", pushed(OWN_POST)],
  ["another channel", pushed(TOP_LEVEL, "channel", "C0ELSEWHERE")],
  ["a body that is no event callback", { type: "url_verification", challenge: "c" }],
  ["a direct message", pushed(TOP_LEVEL, "im")],
])("a pushed %s is no occurrence", async (_name, event) => {
  expect(await messages.fromPush(params, event)).toBeNull();
});

test("a pushed mention is one for mentions, and a plain message is not", async () => {
  expect((await mentions.fromPush(params, pushed(MENTION)))?.inputs).toEqual({
    channel: CHANNEL,
    ts: MENTION.ts,
  });
  expect(await mentions.fromPush(params, pushed(TOP_LEVEL))).toBeNull();
});

test.each([
  ["another bot's post", OTHER_BOT],
  ["an app's post with no subtype", APP_POST],
  ["a post with a file", FILE_POST],
  ["a /me post", ME_POST],
])("%s starts a run, polled or pushed", async (_name, message) => {
  vi.spyOn(slackApi, "slackHistory").mockResolvedValue([message]);
  const occurrence = { channel: CHANNEL, ts: message.ts };
  const { occurrences } = await messages.poll(params, undefined, new Date(0));
  expect(occurrences.map((seen) => seen.inputs)).toEqual([occurrence]);
  expect((await messages.fromPush(params, pushed(message)))?.inputs).toEqual(occurrence);
});

test("another bot's post that mentions the bot is a mention", async () => {
  const tagged = { ...OTHER_BOT, text: `<@${BOT.userId}> please check the deploy` };
  expect((await mentions.fromPush(params, pushed(tagged)))?.inputs).toEqual({
    channel: CHANNEL,
    ts: tagged.ts,
  });
  expect(await mentions.fromPush(params, pushed(OTHER_BOT))).toBeNull();
});

test("a pushed message reads the bot of the app and workspace it came from", async () => {
  await messages.fromPush(params, pushed(TOP_LEVEL));
  expect(slackApi.slackBot).toHaveBeenCalledWith({ appId: "A0C5JPZUW1J", team: "T0A7SCMC5" });
});
