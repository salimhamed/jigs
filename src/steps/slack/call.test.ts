import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { configureSlack, SlackApiError } from "../../providers/slack.ts";
import { type FetchCall, fakeFetch } from "../../providers/test-support.ts";
import { callSlack } from "./call.ts";

const CHANNEL = "C0C5EUZ7P9Q";
const TS = "1790723478.961719";

type Route = (params: URLSearchParams) => unknown;
let routes: Record<string, Route>;
let calls: FetchCall[];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  routes = {};
  const fake = fakeFetch((call) => {
    const method = call.url.pathname.slice(call.url.pathname.lastIndexOf("/") + 1);
    const route = routes[method];
    if (route === undefined) throw new Error(`unexpected ${method}`);
    return new Response(JSON.stringify(route(new URLSearchParams(call.body))));
  });
  calls = fake.calls;
  configureSlack({ fetch: fake.fetch, env: () => "xoxb-test" });
});
afterEach(() => {
  vi.restoreAllMocks();
  configureSlack({});
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
  expect(calls[0]?.headers.authorization).toBe("Bearer xoxb-test");
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
