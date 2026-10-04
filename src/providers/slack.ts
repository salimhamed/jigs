// Every Slack Web API call jigs makes, and the one transport a factory's own
// `callSlack` goes through. A factory's Slack app always acts as itself: the
// bot token for the Web API, the app-level token only to open a Socket Mode
// connection. Reads env and hits the network, so it is reached from a step, a
// check or the service, never from workflow code.

import {
  currentFactoryContext,
  type FactoryContext,
  runSignal,
} from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import type { JsonValue } from "../workflow/human/questions.ts";
import { perContext, requireCredential } from "./credentials.ts";
import { ProviderApiError, rateLimitWait, retryAfterSeconds } from "./http.ts";

export const SLACK_API_URL = "https://slack.com/api";

/** The bot token scopes jigs needs, in the order setup lists them. */
export const SLACK_BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "chat:write",
  "users:read",
  "users:read.email",
] as const;

export type SlackToken = "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN";

// A ceiling for a proxy that answers every page with a cursor, not a real
// channel's size.
const MAX_PAGES = 50;

/**
 * Slack answered a Web API call with `ok: false`. Check `code` to handle one
 * answer, such as `already_reacted`.
 *
 * @group Errors
 */
export class SlackApiError extends ProviderApiError {
  /** Slack's `error` string, such as `invalid_auth` or `already_reacted`. */
  declare readonly code: string;

  constructor(
    method: string,
    code: string,
    needed?: string,
    answer: { status: number; body: string } = { status: 200, body: "" },
  ) {
    super({
      provider: "slack",
      request: method,
      code,
      ...answer,
      message: `Slack ${method}: ${code}${needed === undefined ? "" : ` (needs ${needed})`}`,
    });
    this.name = "SlackApiError";
  }
}

/**
 * Web API arguments. A value that is not a string is sent JSON-encoded, the way
 * Slack takes `blocks`.
 *
 * @group Any Web API method
 */
export type SlackParams = Record<string, JsonValue | undefined>;

export interface SlackReply {
  ok: boolean;
  error?: string;
  needed?: string;
  response_metadata?: { next_cursor?: string };
}

export interface SlackClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The factory whose token it sends. Defaults to the process's own, resolved on each call. */
  context?: FactoryContext;
}

/** Who the bot token acts as, and the scopes Slack reports it holds. */
export interface SlackAuth {
  userId: string;
  botId: string;
  user: string;
  team: string;
  scopes: string[];
}

/** A channel message as Slack returns it. */
export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  thread_ts?: string;
}

/** A Slack user as jigs names them: display name, else real name, else handle. */
export interface SlackUser {
  id: string;
  name: string;
  email?: string;
  bot: boolean;
}

export function createSlackClient(deps: SlackClientDeps = {}) {
  const ctx = () => deps.context ?? currentFactoryContext();
  // Form-encoded, because every Web API method accepts it and not every read
  // method accepts JSON.
  // A token is read from .env, not minted, so a rejected one is not retried.
  async function slackCall<T extends SlackReply>(
    method: string,
    params: SlackParams = {},
    token: SlackToken = "SLACK_BOT_TOKEN",
  ): Promise<{ body: T; headers: Headers }> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined)
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    let waits = 0;
    for (;;) {
      const credential = requireCredential(token, undefined, ctx().env);
      const res = await (deps.fetch ?? fetch)(`${SLACK_API_URL}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      const text = await res.text();
      if (
        res.status === 429 &&
        (await rateLimitWait("slack", retryAfterSeconds(res), waits++, runSignal, deps.sleep))
      ) {
        continue;
      }
      let body: T;
      try {
        body = JSON.parse(text) as T;
      } catch {
        throw new ProviderApiError({
          provider: "slack",
          status: res.status,
          request: method,
          body: text,
          detail: `answered HTTP ${res.status}`,
        });
      }
      if (!body.ok) {
        throw new SlackApiError(method, body.error ?? `HTTP ${res.status}`, body.needed, {
          status: res.status,
          body: text,
        });
      }
      return { body, headers: res.headers };
    }
  }

  async function slackPages<T>(method: string, params: SlackParams, key: string): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { body } = await slackCall<SlackReply & Record<string, unknown>>(method, {
        ...params,
        limit: "200",
        cursor,
      });
      all.push(...((body[key] as T[] | undefined) ?? []));
      cursor = body.response_metadata?.next_cursor || undefined;
      if (cursor === undefined) return all;
    }
    throw new JigsError(`Slack ${method} kept returning a next cursor past ${MAX_PAGES} pages`);
  }

  /** Call `auth.test` with the bot token. Uncached, so a check sees a revoked token. */
  async function slackAuthTest(): Promise<SlackAuth> {
    const { body, headers } = await slackCall<
      SlackReply & { user_id: string; bot_id: string; user: string; team: string }
    >("auth.test");
    return {
      userId: body.user_id,
      botId: body.bot_id,
      user: body.user,
      team: body.team,
      scopes: (headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== ""),
    };
  }

  /** A channel's messages after `oldest` (exclusive), newest first, as Slack returns them. */
  function slackHistory(channel: string, { oldest }: { oldest: string }) {
    return slackPages<SlackMessage>("conversations.history", { channel, oldest }, "messages");
  }

  /** A thread: its parent message, then every reply in order. */
  function slackReplies(channel: string, ts: string) {
    return slackPages<SlackMessage>("conversations.replies", { channel, ts }, "messages");
  }

  /** Post plain `mrkdwn` text, as a reply when `threadTs` is given. Returns the new message's ts. */
  async function slackPostMessage(message: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<string> {
    const { body } = await slackCall<SlackReply & { ts: string }>("chat.postMessage", {
      channel: message.channel,
      text: message.text,
      thread_ts: message.threadTs,
    });
    return body.ts;
  }

  /** A link to one message. */
  async function slackPermalink(channel: string, ts: string): Promise<string> {
    const { body } = await slackCall<SlackReply & { permalink: string }>("chat.getPermalink", {
      channel,
      message_ts: ts,
    });
    return body.permalink;
  }

  async function slackUser(id: string): Promise<SlackUser> {
    const { body } = await slackCall<
      SlackReply & {
        user: {
          id: string;
          name: string;
          is_bot: boolean;
          profile?: { display_name?: string; real_name?: string; email?: string };
        };
      }
    >("users.info", { user: id });
    const { user } = body;
    return {
      id: user.id,
      name: user.profile?.display_name || user.profile?.real_name || user.name,
      ...(user.profile?.email ? { email: user.profile.email } : {}),
      bot: user.is_bot,
    };
  }

  /** Open a Socket Mode connection with the app-level token. Returns its WebSocket URL. */
  async function slackOpenConnection(): Promise<string> {
    const { body } = await slackCall<SlackReply & { url: string }>(
      "apps.connections.open",
      {},
      "SLACK_APP_TOKEN",
    );
    return body.url;
  }

  return {
    slackCall,
    slackAuthTest,
    slackHistory,
    slackReplies,
    slackPostMessage,
    slackPermalink,
    slackUser,
    slackOpenConnection,
  };
}

export type SlackClient = ReturnType<typeof createSlackClient>;

/** The process's Slack client. The functions below call it, so a test can spy on its methods. */
export const slackClient: SlackClient = createSlackClient();

export function slackCall<T extends SlackReply>(
  method: string,
  params?: SlackParams,
  token?: SlackToken,
): Promise<{ body: T; headers: Headers }> {
  return slackClient.slackCall<T>(method, params, token);
}
export const slackAuthTest: SlackClient["slackAuthTest"] = () => slackClient.slackAuthTest();
export const slackHistory: SlackClient["slackHistory"] = (...args) =>
  slackClient.slackHistory(...args);
export const slackReplies: SlackClient["slackReplies"] = (...args) =>
  slackClient.slackReplies(...args);
export const slackPostMessage: SlackClient["slackPostMessage"] = (...args) =>
  slackClient.slackPostMessage(...args);
export const slackPermalink: SlackClient["slackPermalink"] = (...args) =>
  slackClient.slackPermalink(...args);
export const slackUser: SlackClient["slackUser"] = (...args) => slackClient.slackUser(...args);
export const slackOpenConnection: SlackClient["slackOpenConnection"] = () =>
  slackClient.slackOpenConnection();

const bots = perContext(() => ({ bot: null as Promise<SlackAuth> | null }));

/** The factory's own bot, from `auth.test` once per factory context. */
export function slackBot(): Promise<SlackAuth> {
  const cache = bots();
  cache.bot ??= slackAuthTest().catch((err: unknown) => {
    cache.bot = null;
    throw err;
  });
  return cache.bot;
}
