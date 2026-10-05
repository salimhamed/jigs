import { tmpdir } from "node:os";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { SlackApiError, slackHistory } from "../../providers/slack.ts";
import { useLiveSlackToken } from "../../providers/test-fixtures.ts";
import { waitForSlackReply } from "../../workflow/slack/wait-for-reply.ts";
import { fetchSlackMessage } from "./fetch-message.ts";
import { postSlackMessage } from "./post-message.ts";

// Posts to the test channel, then deletes what it posted. Set SLACK_BOT_TOKEN
// in the shell to a test app's bot token; the app must be in the channel.
const token = process.env.SLACK_BOT_TOKEN;
const configured = Boolean(token);
vi.stubEnv("JIGS_FACTORY_ROOT", tmpdir());

beforeAll(async () => {
  if (token) await useLiveSlackToken(token);
});
const channel = "C0C5EUZ7P9Q";

// A hook that never wakes: the wait either finds a reply on its first read or parks.
const parked = vi.hoisted(() => ({ count: 0 }));
vi.mock("workflow", () => ({
  createHook: () => ({
    // biome-ignore lint/suspicious/noThenProperty: the SDK's Hook is a thenable
    then: () => {
      parked.count += 1;
      return new Promise(() => {});
    },
    dispose: () => {},
  }),
}));

const posted: string[] = [];
async function deleteMessage(ts: string) {
  const res = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ channel, ts }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}
afterAll(async () => {
  for (const ts of posted.reverse()) await deleteMessage(ts);
});

test.skipIf(!configured)(
  "a posted thread snapshots in order, and the bot's reply is its own",
  async () => {
    const ts = await postSlackMessage({ channel, text: "jigs live test: snapshot parent" });
    posted.push(ts);
    const reply = await postSlackMessage({
      channel,
      text: "jigs live test: bot reply",
      threadTs: ts,
    });
    posted.push(reply);

    const snapshot = await fetchSlackMessage({ channel, ts });
    if (snapshot.gone) throw new Error("the message just posted reads as gone");
    expect(snapshot).toMatchObject({
      ts,
      text: "jigs live test: snapshot parent",
      author: { bot: true, isOwnBot: true },
      replies: [{ ts: reply, text: "jigs live test: bot reply", author: { isOwnBot: true } }],
    });
    expect(snapshot.permalink).toMatch(/^https:\/\/.+\/archives\/C0C5EUZ7P9Q\/p\d+/);

    // The bot's reply is no human's, so the wait parks rather than returning it.
    void waitForSlackReply({ channel, threadTs: ts, lastRead: ts }, { fetchSlackMessage });
    await vi.waitFor(() => expect(parked.count).toBe(1), { timeout: 10_000 });
  },
);

test.skipIf(!configured)("a thread reply's ts fails, naming the top-level message", async () => {
  const ts = await postSlackMessage({ channel, text: "jigs live test: reply parent" });
  posted.push(ts);
  const reply = await postSlackMessage({ channel, text: "jigs live test: reply", threadTs: ts });
  posted.push(reply);
  await expect(fetchSlackMessage({ channel, ts: reply })).rejects.toThrow(
    `is a thread reply; pass its thread's top-level message ts, ${ts}`,
  );
});

test.skipIf(!configured)("a deleted message snapshots as gone", async () => {
  const ts = await postSlackMessage({ channel, text: "jigs live test: deleted" });
  expect((await deleteMessage(ts)).ok).toBe(true);
  expect(await fetchSlackMessage({ channel, ts })).toEqual({ gone: true, channel, ts });
});

test.skipIf(!configured)("a human's message snapshots with their name and email", async (ctx) => {
  const since = (Date.now() / 1000 - 30 * 24 * 3600).toFixed(6);
  const human = (await slackHistory(channel, { oldest: since })).find(
    (message) => message.bot_id === undefined && message.subtype === undefined,
  );
  if (human === undefined) return ctx.skip("no human message in the test channel this month");
  try {
    const snapshot = await fetchSlackMessage({ channel, ts: human.ts });
    expect(snapshot).toMatchObject({
      gone: false,
      author: { id: human.user, bot: false, isOwnBot: false, email: expect.stringContaining("@") },
    });
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "missing_scope")
      return ctx.skip(`the bot token lacks a scope: ${error.message}; reinstall the app`);
    throw error;
  }
});
