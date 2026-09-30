import { beforeEach, expect, test, vi } from "vitest";
import * as slackApi from "../providers/slack.ts";
import { slack } from "../workflow/slack/sources.ts";
import { SOURCES } from "./sources.ts";

const BOT = {
  userId: "U0C59SU5V29",
  botId: "B0C5JPZUW1J",
  user: "salims_jigs",
  team: "Jungle Scout",
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
  bot_id: BOT.botId,
  ts: "1790723386.003159",
  text: "posted by the factory",
};
const HISTORY_PAGE = [MENTION, THREAD_REPLY, THREAD_PARENT, OWN_POST, TOP_LEVEL, JOIN];

// A Socket Mode `events_api` envelope's event, recorded from the test channel.
const pushed = (message: object, channelType = "channel") => ({
  ...message,
  channel: CHANNEL,
  channel_type: channelType,
  event_ts: (message as { ts: string }).ts,
  team: "T0A7SCMC5",
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

test("messages polls history after the window and keeps top-level human messages", async () => {
  const history = vi.spyOn(slackApi, "slackHistory").mockResolvedValue(HISTORY_PAGE);
  const since = new Date(1790716000_000);
  const found = await messages.poll(params, since);
  expect(history).toHaveBeenCalledExactlyOnceWith(CHANNEL, { oldest: "1790716000.000000" });
  expect(found).toEqual(
    [MENTION, THREAD_PARENT, TOP_LEVEL].map((m) => ({
      inputs: { channel: CHANNEL, ts: m.ts },
      at: new Date(Number(m.ts) * 1000),
    })),
  );
});

test("mentions keeps only the top-level messages that tag the bot", async () => {
  vi.spyOn(slackApi, "slackHistory").mockResolvedValue(HISTORY_PAGE);
  const found = await mentions.poll(params, new Date(0));
  expect(found.map((seen) => seen.inputs)).toEqual([{ channel: CHANNEL, ts: MENTION.ts }]);
});

test("each channel is read, and a failing one is named", async () => {
  const history = vi
    .spyOn(slackApi, "slackHistory")
    .mockResolvedValueOnce([TOP_LEVEL])
    .mockRejectedValueOnce(new slackApi.SlackApiError("conversations.history", "not_in_channel"));
  await expect(messages.poll({ channels: [CHANNEL, "C0SECOND1"] }, new Date(0))).rejects.toThrow(
    "channel C0SECOND1: Slack conversations.history: not_in_channel",
  );
  expect(history).toHaveBeenCalledTimes(2);
});

test("a pushed message is the same occurrence its poll finds", async () => {
  vi.spyOn(slackApi, "slackHistory").mockResolvedValue([TOP_LEVEL]);
  const [polled] = await messages.poll(params, new Date(0));
  const push = await messages.fromPush(params, pushed(TOP_LEVEL));
  expect(push).toEqual(polled);
  expect(messages.occurrence(push?.inputs ?? {})).toBe(`${CHANNEL}:${TOP_LEVEL.ts}`);
});

test.each([
  ["a thread reply", pushed(THREAD_REPLY)],
  ["a subtype", pushed(JOIN)],
  ["the bot's own post", pushed(OWN_POST)],
  ["another channel", { ...pushed(TOP_LEVEL), channel: "C0ELSEWHERE" }],
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

test("the bot's own post is skipped by its bot id alone", async () => {
  const { user: _user, ...byBotId } = OWN_POST;
  expect(await messages.fromPush(params, pushed(byBotId))).toBeNull();
});
