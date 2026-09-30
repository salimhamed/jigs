import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  resetSlack,
  SlackApiError,
  slackAuthTest,
  slackBot,
  slackHistory,
  slackOpenConnection,
  slackPermalink,
  slackPostMessage,
  slackReplies,
  slackUser,
} from "./slack.ts";

const BOT_TOKEN = "xoxb-test-bot-token";
const APP_TOKEN = "xapp-test-app-token";

// Recorded from the salims_jigs app, trimmed to what jigs reads.
const AUTH_OK = {
  ok: true,
  url: "https://junglescout.slack.com/",
  team: "Jungle Scout",
  user: "salims_jigs",
  team_id: "T0A7SCMC5",
  user_id: "U0C59SU5V29",
  bot_id: "B0C5JPZUW1J",
  is_enterprise_install: false,
};
const SCOPES = "channels:history,groups:history,chat:write,users:read,users:read.email";

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

function sent(index: number): { url: string; auth: string; params: URLSearchParams } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    auth: new Headers(init.headers).get("authorization") ?? "",
    params: new URLSearchParams(String(init.body)),
  };
}

beforeEach(() => {
  vi.stubEnv("SLACK_API_URL", "http://slack.test/api");
  vi.stubEnv("SLACK_BOT_TOKEN", BOT_TOKEN);
  vi.stubEnv("SLACK_APP_TOKEN", APP_TOKEN);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  resetSlack();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("auth.test names the bot and reads its scopes from the response header", async () => {
  fetchMock.mockResolvedValueOnce(reply(AUTH_OK, { headers: { "x-oauth-scopes": SCOPES } }));
  expect(await slackAuthTest()).toEqual({
    userId: "U0C59SU5V29",
    botId: "B0C5JPZUW1J",
    user: "salims_jigs",
    team: "Jungle Scout",
    scopes: SCOPES.split(","),
  });
  expect(sent(0)).toMatchObject({
    url: "http://slack.test/api/auth.test",
    auth: `Bearer ${BOT_TOKEN}`,
  });
});

test("a response without the scopes header reports the scopes as unknown", async () => {
  fetchMock.mockResolvedValueOnce(reply(AUTH_OK));
  expect((await slackAuthTest()).scopes).toBeNull();
});

test("a Slack error carries its code and never the token", async () => {
  fetchMock.mockResolvedValueOnce(reply({ ok: false, error: "invalid_auth" }));
  const error = await slackAuthTest().catch((err: unknown) => err);
  expect(error).toBeInstanceOf(SlackApiError);
  expect(error).toMatchObject({ method: "auth.test", code: "invalid_auth" });
  expect(String(error)).not.toContain(BOT_TOKEN);
});

test("a missing scope names the scope Slack asked for", async () => {
  fetchMock.mockResolvedValueOnce(
    reply({
      ok: false,
      error: "missing_scope",
      needed: "users:read",
      provided: "channels:history,groups:history,chat:write",
    }),
  );
  const error = await slackUser("U1").catch((err: unknown) => err);
  expect(error).toMatchObject({ code: "missing_scope", needed: "users:read" });
  expect((error as Error).message).toContain("users:read");
});

test("an unset bot token names the .env key before any request", async () => {
  vi.stubEnv("SLACK_BOT_TOKEN", "");
  await expect(slackAuthTest()).rejects.toThrow("SLACK_BOT_TOKEN is not set");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a non-JSON answer reports the HTTP status, not the body", async () => {
  fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
  await expect(slackAuthTest()).rejects.toThrow("Slack auth.test answered HTTP 502");
});

test("a rate-limited call waits out Retry-After and tries again", async () => {
  vi.useFakeTimers();
  fetchMock
    .mockResolvedValueOnce(
      reply({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "7" } }),
    )
    .mockResolvedValueOnce(reply(AUTH_OK));
  const pending = slackAuthTest();
  await vi.advanceTimersByTimeAsync(6_999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).userId).toBe("U0C59SU5V29");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a call still rate-limited after its retries fails as ratelimited", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(async () =>
    reply({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "1" } }),
  );
  const pending = slackAuthTest().catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toMatchObject({ code: "ratelimited" });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("the bot's own identity is read once per process", async () => {
  fetchMock.mockImplementation(async () => reply(AUTH_OK));
  const [first, second] = await Promise.all([slackBot(), slackBot()]);
  expect(first).toEqual(second);
  expect(await slackBot()).toMatchObject({ userId: "U0C59SU5V29", botId: "B0C5JPZUW1J" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a failed identity read is not cached", async () => {
  fetchMock
    .mockResolvedValueOnce(reply({ ok: false, error: "invalid_auth" }))
    .mockResolvedValueOnce(reply(AUTH_OK));
  await expect(slackBot()).rejects.toThrow("invalid_auth");
  expect((await slackBot()).userId).toBe("U0C59SU5V29");
});

const message = (ts: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  user: "U01PW925E6N",
  text: `message ${ts}`,
  ts,
  ...extra,
});

test("history follows the cursor across pages, newest first, from oldest", async () => {
  fetchMock
    .mockResolvedValueOnce(
      reply({
        ok: true,
        messages: [message("1790723478.961719"), message("1790723415.832429")],
        has_more: true,
        response_metadata: { next_cursor: "bmV4dF90czoxNzkwNzIzNDE1ODMyNDI5" },
      }),
    )
    .mockResolvedValueOnce(
      reply({
        ok: true,
        messages: [message("1790723400.000100", { subtype: "channel_join" })],
        has_more: false,
        response_metadata: { next_cursor: "" },
      }),
    );
  const messages = await slackHistory("C0C5EUZ7P9Q", { oldest: "1790723000.000000" });
  expect(messages.map((m) => m.ts)).toEqual([
    "1790723478.961719",
    "1790723415.832429",
    "1790723400.000100",
  ]);
  expect(messages[2]?.subtype).toBe("channel_join");
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    oldest: "1790723000.000000",
    limit: "200",
  });
  expect(sent(1).params.get("cursor")).toBe("bmV4dF90czoxNzkwNzIzNDE1ODMyNDI5");
});

test("replies return the parent then its thread, in order", async () => {
  fetchMock.mockResolvedValueOnce(
    reply({
      ok: true,
      messages: [
        message("1790723478.961719", { thread_ts: "1790723478.961719", reply_count: 1 }),
        message("1790723839.836679", { thread_ts: "1790723478.961719", bot_id: "B0C5JPZUW1J" }),
      ],
      has_more: false,
    }),
  );
  const thread = await slackReplies("C0C5EUZ7P9Q", "1790723478.961719");
  expect(thread.map((m) => m.ts)).toEqual(["1790723478.961719", "1790723839.836679"]);
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    ts: "1790723478.961719",
    limit: "200",
  });
});

test("posting sends plain text, in the thread when asked, and returns the new ts", async () => {
  fetchMock.mockImplementation(async () =>
    reply({ ok: true, channel: "C0C5EUZ7P9Q", ts: "1790724000.000200", message: {} }),
  );
  expect(
    await slackPostMessage({ channel: "C0C5EUZ7P9Q", text: "*hi*", threadTs: "1790723478.961719" }),
  ).toBe("1790724000.000200");
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    text: "*hi*",
    thread_ts: "1790723478.961719",
  });
  await slackPostMessage({ channel: "C0C5EUZ7P9Q", text: "top level" });
  expect(sent(1).params.has("thread_ts")).toBe(false);
});

test("a permalink is read for a message", async () => {
  const permalink =
    "https://junglescout.slack.com/archives/C0C5EUZ7P9Q/p1790723478961719?thread_ts=1790723478.961719&cid=C0C5EUZ7P9Q";
  fetchMock.mockResolvedValueOnce(reply({ ok: true, permalink, channel: "C0C5EUZ7P9Q" }));
  expect(await slackPermalink("C0C5EUZ7P9Q", "1790723478.961719")).toBe(permalink);
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    message_ts: "1790723478.961719",
  });
});

test("a user reads as their display name and email, falling back to the real name", async () => {
  fetchMock
    .mockResolvedValueOnce(
      reply({
        ok: true,
        user: {
          id: "U01PW925E6N",
          name: "salim",
          is_bot: false,
          profile: { display_name: "Salim", real_name: "Salim Hamed", email: "salim@example.com" },
        },
      }),
    )
    .mockResolvedValueOnce(
      reply({
        ok: true,
        user: {
          id: "U0C59SU5V29",
          name: "salims_jigs",
          is_bot: true,
          profile: { display_name: "", real_name: "Salim's jigs" },
        },
      }),
    );
  expect(await slackUser("U01PW925E6N")).toEqual({
    id: "U01PW925E6N",
    name: "Salim",
    email: "salim@example.com",
    bot: false,
  });
  expect(await slackUser("U0C59SU5V29")).toEqual({
    id: "U0C59SU5V29",
    name: "Salim's jigs",
    bot: true,
  });
  expect(Object.fromEntries(sent(0).params)).toEqual({ user: "U01PW925E6N" });
});

test("a Socket Mode connection is opened with the app-level token", async () => {
  fetchMock.mockResolvedValueOnce(
    reply({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=t" }),
  );
  expect(await slackOpenConnection()).toBe("wss://wss-primary.slack.com/link/?ticket=t");
  expect(sent(0)).toMatchObject({
    url: "http://slack.test/api/apps.connections.open",
    auth: `Bearer ${APP_TOKEN}`,
  });
});

test("an unset app token names its .env key", async () => {
  vi.stubEnv("SLACK_APP_TOKEN", "");
  await expect(slackOpenConnection()).rejects.toThrow("SLACK_APP_TOKEN is not set");
});
