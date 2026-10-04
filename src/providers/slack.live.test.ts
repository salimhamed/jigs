import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import {
  slackAuthTest,
  slackBot,
  slackHistory,
  slackOpenConnection,
  slackPermalink,
  slackReplies,
} from "./slack.ts";
import { slackIdentityChecks, slackSocketModeChecks } from "./slack-checks.ts";

// The live half of the Slack client, read-only. Set SLACK_BOT_TOKEN (and
// SLACK_APP_TOKEN for Socket Mode) to a test app's that is in the test channel.
const configured = Boolean(process.env.SLACK_BOT_TOKEN);
const socketMode = Boolean(process.env.SLACK_APP_TOKEN);
const channel = "C0C5EUZ7P9Q";
const probes = { authTest: slackAuthTest, openConnection: slackOpenConnection };
const env = (name: string) => process.env[name] || undefined;
// The shell's tokens win over any factory's .env, so any root serves.
vi.stubEnv("JIGS_FACTORY_ROOT", tmpdir());

test.skipIf(!configured)("auth.test names the bot and reports its scopes", async () => {
  const auth = await slackAuthTest();
  expect(auth.userId).toMatch(/^U/);
  expect(auth.botId).toMatch(/^B/);
  expect(auth.scopes).toEqual(expect.arrayContaining(["channels:history", "chat:write"]));
  expect(await slackBot()).toEqual(auth);
});

test.skipIf(!configured)("history, replies and a permalink read the test channel", async () => {
  const since = (Date.now() / 1000 - 30 * 24 * 3600).toFixed(6);
  const messages = await slackHistory(channel, { oldest: since });
  const [newest] = messages;
  if (newest === undefined) return;
  expect(newest.ts).toMatch(/^\d+\.\d+$/);
  const thread = await slackReplies(channel, newest.thread_ts ?? newest.ts);
  expect(thread[0]?.ts).toBe(newest.thread_ts ?? newest.ts);
  expect(await slackPermalink(channel, newest.ts)).toMatch(/^https:\/\/.+\/archives\//);
});

test.skipIf(!configured)("the bot token holds every scope jigs needs", async () => {
  const [identity] = slackIdentityChecks(probes, [], env);
  expect(await identity?.run()).toMatchObject({ ok: true });
});

test.skipIf(!socketMode)("the app-level token opens a Socket Mode connection", async () => {
  const [socket] = slackSocketModeChecks({ socketMode: true }, probes, env);
  expect(await socket?.run()).toEqual({ ok: true });
});
