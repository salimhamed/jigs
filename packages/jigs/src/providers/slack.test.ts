import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { testFactoryContext } from "../test-fixtures.ts";
import {
  createSlackClient,
  SLACK_API_URL,
  SlackApiError,
  type SlackClient,
  slackBot,
} from "./slack.ts";
import { TEST_SLACK_BOT, TEST_SLACK_TOKEN, useSlackClient } from "./test-fixtures.ts";
import { type FetchCall, fakeFetch, fakeSleep } from "./test-support.ts";

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

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

let factories = 0;
let answers: Array<() => Response>;
let calls: FetchCall[];
let sleeps: number[];
let slack: SlackClient;
let slackTokens: ReturnType<typeof useSlackClient>;

// Answers each call with the next queued answer, repeating the last.
function answer(...next: Array<() => Response>) {
  answers.push(...next);
}

function sent(index: number): { url: string; auth: string; params: URLSearchParams } {
  const call = calls[index];
  if (call === undefined) throw new Error(`no call ${index}`);
  return {
    url: call.url.toString(),
    auth: call.headers.authorization ?? "",
    params: new URLSearchParams(call.body),
  };
}

beforeEach(() => {
  answers = [];
  const fake = fakeFetch(() => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === undefined) throw new Error("no answer queued");
    return next();
  });
  const sleep = fakeSleep();
  calls = fake.calls;
  sleeps = sleep.sleeps;
  const deps = {
    fetch: fake.fetch,
    sleep: sleep.sleep,
    context: testFactoryContext(),
  };
  slackTokens = useSlackClient(deps);
  slack = createSlackClient(deps);
  factories += 1;
  vi.stubEnv("JIGS_FACTORY_ROOT", `/slack-test-${factories}`);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const authTest = async () =>
  (await slack.slackCall<{ ok: true; user_id: string }>("auth.test")).body;

test("a call sends the bot token the hub hands out", async () => {
  answer(() => reply(AUTH_OK));
  expect((await authTest()).user_id).toBe("U0C59SU5V29");
  expect(sent(0)).toMatchObject({
    url: `${SLACK_API_URL}/auth.test`,
    auth: `Bearer ${TEST_SLACK_TOKEN}`,
  });
});

test("a Slack error carries its code and never the token", async () => {
  answer(() => reply({ ok: false, error: "channel_not_found" }));
  const error = await authTest().catch((err: unknown) => err);
  expect(error).toBeInstanceOf(SlackApiError);
  expect(error).toMatchObject({
    code: "channel_not_found",
    message: "Slack auth.test: channel_not_found",
  });
  expect(String(error)).not.toContain(TEST_SLACK_TOKEN);
});

test.each(["invalid_auth", "token_revoked"])(
  "a token Slack answers %s to is asked of the hub again, once",
  async (code) => {
    slackTokens
      .mockResolvedValueOnce({ token: "xoxb-old", app: TEST_SLACK_BOT, team: "T0", scopes: [] })
      .mockResolvedValueOnce({ token: "xoxb-new", app: TEST_SLACK_BOT, team: "T0", scopes: [] });
    answer(
      () => reply({ ok: false, error: code }),
      () => reply(AUTH_OK),
    );
    expect((await authTest()).user_id).toBe("U0C59SU5V29");
    expect([sent(0).auth, sent(1).auth]).toEqual(["Bearer xoxb-old", "Bearer xoxb-new"]);
    await authTest();
    expect(slackTokens).toHaveBeenCalledTimes(2);
  },
);

test("a token Slack refuses twice fails", async () => {
  answer(() => reply({ ok: false, error: "invalid_auth" }));
  await expect(authTest()).rejects.toMatchObject({ code: "invalid_auth" });
  expect(calls).toHaveLength(2);
});

test("a missing scope names the scope Slack asked for", async () => {
  answer(() =>
    reply({
      ok: false,
      error: "missing_scope",
      needed: "users:read",
      provided: "channels:history,groups:history,chat:write",
    }),
  );
  const error = await slack.slackUser("U1").catch((err: unknown) => err);
  expect(error).toMatchObject({
    code: "missing_scope",
    message: "Slack users.info: missing_scope (needs users:read)",
  });
});

test("a non-JSON answer reports the HTTP status, not the body", async () => {
  answer(() => new Response("<html>bad gateway</html>", { status: 502 }));
  const error = await authTest().catch((err: unknown) => err);
  expect(error).toMatchObject({
    provider: "slack",
    status: 502,
    message: "Slack API 502 on auth.test: answered HTTP 502",
  });
});

test("a rate-limited call waits out Retry-After and tries again", async () => {
  answer(
    () =>
      reply({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "7" } }),
    () => reply(AUTH_OK),
  );
  expect((await authTest()).user_id).toBe("U0C59SU5V29");
  expect(sleeps).toEqual([7_000]);
  expect(calls).toHaveLength(2);
});

test("an unreadable Retry-After waits one second", async () => {
  answer(
    () =>
      reply(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "retry-after": "soon" } },
      ),
    () => reply(AUTH_OK),
  );
  expect((await authTest()).user_id).toBe("U0C59SU5V29");
  expect(sleeps).toEqual([1_000]);
});

test("a Retry-After over a minute fails as ratelimited instead of waiting", async () => {
  answer(() =>
    reply({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "61" } }),
  );
  await expect(authTest()).rejects.toMatchObject({ code: "ratelimited", status: 429 });
  expect(calls).toHaveLength(1);
  expect(sleeps).toEqual([]);
});

test("a call still rate-limited after its retries fails as ratelimited", async () => {
  answer(() =>
    reply({ ok: false, error: "ratelimited" }, { status: 429, headers: { "retry-after": "1" } }),
  );
  await expect(authTest()).rejects.toMatchObject({ code: "ratelimited" });
  expect(calls).toHaveLength(4);
  expect(sleeps).toEqual([1_000, 1_000, 1_000]);
});

test("the bot is read from the hub once per factory context", async () => {
  const [first, second] = await Promise.all([slackBot(), slackBot()]);
  expect(first).toEqual(second);
  expect(first).toEqual({
    userId: TEST_SLACK_BOT.botUserId,
    appId: TEST_SLACK_BOT.appId,
    name: TEST_SLACK_BOT.name,
    team: "T0TEST",
    scopes: expect.any(Array),
  });
  expect(slackTokens).toHaveBeenCalledTimes(1);
  vi.stubEnv("JIGS_FACTORY_ROOT", "/another-factory");
  await slackBot();
  expect(slackTokens).toHaveBeenCalledTimes(2);
  expect(calls).toHaveLength(0);
});

test("a failed token request is not cached", async () => {
  slackTokens.mockRejectedValueOnce(new Error("hub down"));
  await expect(slackBot()).rejects.toThrow("hub down");
  expect((await slackBot()).userId).toBe(TEST_SLACK_BOT.botUserId);
});

const message = (ts: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  user: "U01PW925E6N",
  text: `message ${ts}`,
  ts,
  ...extra,
});

test("a listing follows the cursor across pages", async () => {
  answer(
    () =>
      reply({
        ok: true,
        messages: [message("1790723478.961719"), message("1790723415.832429")],
        has_more: true,
        response_metadata: { next_cursor: "bmV4dF90czoxNzkwNzIzNDE1ODMyNDI5" },
      }),
    () =>
      reply({
        ok: true,
        messages: [message("1790723400.000100", { subtype: "channel_join" })],
        has_more: false,
        response_metadata: { next_cursor: "" },
      }),
  );
  const messages = await slack.slackReplies("C0C5EUZ7P9Q", "1790723000.000000");
  expect(messages.map((m) => m.ts)).toEqual([
    "1790723478.961719",
    "1790723415.832429",
    "1790723400.000100",
  ]);
  expect(messages[2]?.subtype).toBe("channel_join");
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    ts: "1790723000.000000",
    limit: "200",
  });
  expect(sent(1).params.get("cursor")).toBe("bmV4dF90czoxNzkwNzIzNDE1ODMyNDI5");
});

test("replies return the parent then its thread, in order", async () => {
  answer(() =>
    reply({
      ok: true,
      messages: [
        message("1790723478.961719", { thread_ts: "1790723478.961719", reply_count: 1 }),
        message("1790723839.836679", { thread_ts: "1790723478.961719", bot_id: "B0C5JPZUW1J" }),
      ],
      has_more: false,
    }),
  );
  const thread = await slack.slackReplies("C0C5EUZ7P9Q", "1790723478.961719");
  expect(thread.map((m) => m.ts)).toEqual(["1790723478.961719", "1790723839.836679"]);
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    ts: "1790723478.961719",
    limit: "200",
  });
});

test("posting sends plain text, in the thread when asked, and returns the new ts", async () => {
  answer(() => reply({ ok: true, channel: "C0C5EUZ7P9Q", ts: "1790724000.000200", message: {} }));
  expect(
    await slack.slackPostMessage({
      channel: "C0C5EUZ7P9Q",
      text: "*hi*",
      threadTs: "1790723478.961719",
    }),
  ).toBe("1790724000.000200");
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    text: "*hi*",
    thread_ts: "1790723478.961719",
  });
  await slack.slackPostMessage({ channel: "C0C5EUZ7P9Q", text: "top level" });
  expect(sent(1).params.has("thread_ts")).toBe(false);
});

test("a permalink is read for a message", async () => {
  const permalink =
    "https://junglescout.slack.com/archives/C0C5EUZ7P9Q/p1790723478961719?thread_ts=1790723478.961719&cid=C0C5EUZ7P9Q";
  answer(() => reply({ ok: true, permalink, channel: "C0C5EUZ7P9Q" }));
  expect(await slack.slackPermalink("C0C5EUZ7P9Q", "1790723478.961719")).toBe(permalink);
  expect(Object.fromEntries(sent(0).params)).toEqual({
    channel: "C0C5EUZ7P9Q",
    message_ts: "1790723478.961719",
  });
});

test("a user reads as their display name and email, falling back to the real name", async () => {
  answer(
    () =>
      reply({
        ok: true,
        user: {
          id: "U01PW925E6N",
          name: "salim",
          is_bot: false,
          profile: { display_name: "Salim", real_name: "Salim Hamed", email: "salim@example.com" },
        },
      }),
    () =>
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
  expect(await slack.slackUser("U01PW925E6N")).toEqual({
    id: "U01PW925E6N",
    name: "Salim",
    email: "salim@example.com",
    bot: false,
  });
  expect(await slack.slackUser("U0C59SU5V29")).toEqual({
    id: "U0C59SU5V29",
    name: "Salim's jigs",
    bot: true,
  });
  expect(Object.fromEntries(sent(0).params)).toEqual({ user: "U01PW925E6N" });
});

test("a listing stops at a ceiling when every page claims another", async () => {
  answer(() =>
    reply({
      ok: true,
      messages: [message("1790723478.961719")],
      response_metadata: { next_cursor: "again" },
    }),
  );
  await expect(slack.slackReplies("C0C5EUZ7P9Q", "1790723478.961719")).rejects.toThrow(
    "Slack conversations.replies kept returning a next cursor past 50 pages",
  );
  expect(calls).toHaveLength(50);
});
