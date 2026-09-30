import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SlackApiError } from "../../providers/slack.ts";
import { callSlack } from "./call.ts";

const CHANNEL = "C0C5EUZ7P9Q";
const TS = "1790723478.961719";

type Route = (params: URLSearchParams) => unknown;
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("SLACK_API_URL", "http://slack.test/api");
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  routes = {};
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const route = routes[method];
    if (route === undefined) throw new Error(`unexpected ${method}`);
    return new Response(JSON.stringify(route(new URLSearchParams(String(init.body)))));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("any method is called as the bot, with non-string params JSON-encoded", async () => {
  let sent: URLSearchParams | undefined;
  routes["chat.update"] = (params) => {
    sent = params;
    return { ok: true, channel: CHANNEL, ts: TS, text: "Shipped" };
  };
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Shipped*" } }];
  const body = await callSlack<{ ts: string; text: string }>("chat.update", {
    channel: CHANNEL,
    ts: TS,
    blocks,
    unfurl_links: false,
    thread_ts: undefined,
  });
  expect(body).toEqual({ ok: true, channel: CHANNEL, ts: TS, text: "Shipped" });
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer xoxb-test");
  expect(Object.fromEntries(sent ?? [])).toEqual({
    channel: CHANNEL,
    ts: TS,
    blocks: JSON.stringify(blocks),
    unfurl_links: "false",
  });
});

test("a Slack error from any method carries Slack's code", async () => {
  routes["reactions.add"] = () => ({ ok: false, error: "already_reacted" });
  const error = await callSlack("reactions.add", {
    channel: CHANNEL,
    timestamp: TS,
    name: "eyes",
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SlackApiError);
  expect(error).toMatchObject({
    code: "already_reacted",
    message: "Slack reactions.add: already_reacted",
  });
});
