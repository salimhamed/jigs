import { tmpdir } from "node:os";
import { beforeAll, expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import { type SlackMessage, slackBot, slackFor } from "./slack.ts";
import { slackInstallationProbe } from "./slack-checks.ts";
import { useLiveSlackToken } from "./test-fixtures.ts";

// The live half of the Slack client, read-only. Set JIGS_TEST_SLACK_BOT_TOKEN in the
// shell to a test app's bot token; the app must be in the test channel.
const token = process.env.JIGS_TEST_SLACK_BOT_TOKEN;
const configured = Boolean(token);
const channel = "C0C5EUZ7P9Q";
vi.stubEnv("JIGS_FACTORY_ROOT", tmpdir());

beforeAll(async () => {
  if (token) await useLiveSlackToken(token);
});

test.skipIf(!configured)("the bot is the token's own user", async () => {
  expect((await slackBot("live")).userId).toMatch(/^U/);
});

test.skipIf(!configured)("history, replies and a permalink read the test channel", async () => {
  const slack = slackFor("live");
  const since = (Date.now() / 1000 - 30 * 24 * 3600).toFixed(6);
  const { messages } = (
    await slack.slackCall<{ ok: true; messages: SlackMessage[] }>("conversations.history", {
      channel,
      oldest: since,
    })
  ).body;
  const [newest] = messages;
  if (newest === undefined) return;
  expect(newest.ts).toMatch(/^\d+\.\d+$/);
  const thread = await slack.slackReplies(channel, newest.thread_ts ?? newest.ts);
  expect(thread[0]?.ts).toBe(newest.thread_ts ?? newest.ts);
  expect(await slack.slackPermalink(channel, newest.ts)).toMatch(/^https:\/\/.+\/archives\//);
});

test.skipIf(!configured)("the bot token holds every scope jigs needs", async () => {
  const probe = slackInstallationProbe(testFactoryContext({ env: {} }));
  expect(await probe("live")).toMatchObject({ ok: true });
});
