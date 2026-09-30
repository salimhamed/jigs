// Every Slack Web API call jigs makes. A factory's Slack app always acts as
// itself: the bot token for the Web API, the app-level token only to open a
// Socket Mode connection. Reads env and hits the network, so it is reached
// from a step, a check or the service, never from workflow code.

import { factoryEnvValue } from "../config/factory-env.ts";
import { JigsError } from "../errors.ts";
import { credentialRoot } from "./credential-root.ts";

// A test seam.
const SLACK_API_URL = (): string => process.env.SLACK_API_URL ?? "https://slack.com/api";

/** The bot token scopes jigs needs, in the order setup lists them. */
export const SLACK_BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "chat:write",
  "users:read",
  "users:read.email",
] as const;

export type SlackToken = "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN";

// Beyond these Slack is refusing on purpose, and waiting longer only holds a step.
const RATE_LIMITED_ATTEMPTS = 4;
const MAX_RETRY_AFTER_SECONDS = 60;

// A ceiling for a proxy that answers every page with a cursor, not a real
// channel's size.
const MAX_PAGES = 50;

/** A Slack credential from the factory's `.env`, or the shell outside a factory. */
export function slackEnvValue(name: SlackToken): string | undefined {
  try {
    return factoryEnvValue(credentialRoot(), name);
  } catch {
    const exported = process.env[name];
    return exported === "" ? undefined : exported;
  }
}

/** Slack answered `ok: false`. `code` is Slack's error string, such as `invalid_auth`. */
export class SlackApiError extends JigsError {
  readonly code: string;

  constructor(method: string, code: string, needed?: string) {
    super(`Slack ${method}: ${code}${needed === undefined ? "" : ` (needs ${needed})`}`);
    this.code = code;
  }
}

type Params = Record<string, string | undefined>;

interface SlackReply {
  ok: boolean;
  error?: string;
  needed?: string;
  response_metadata?: { next_cursor?: string };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Form-encoded, because every Web API method accepts it and not every read
// method accepts JSON.
async function slackCall<T extends SlackReply>(
  method: string,
  params: Params = {},
  token: SlackToken = "SLACK_BOT_TOKEN",
): Promise<{ body: T; headers: Headers }> {
  const secret = slackEnvValue(token);
  if (secret === undefined) {
    throw new JigsError(
      `${token} is not set`,
      `set ${token} in the factory repo's .env, then: \`pnpm exec jigs service restart\``,
    );
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) form.set(key, value);
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(`${SLACK_API_URL()}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (res.status === 429) {
      const seconds = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      const wait = Number.isNaN(seconds) ? 1 : seconds;
      if (attempt < RATE_LIMITED_ATTEMPTS && wait <= MAX_RETRY_AFTER_SECONDS) {
        await sleep(wait * 1000);
        continue;
      }
    }
    let body: T;
    try {
      body = (await res.json()) as T;
    } catch {
      throw new JigsError(`Slack ${method} answered HTTP ${res.status}`);
    }
    if (!body.ok) throw new SlackApiError(method, body.error ?? `HTTP ${res.status}`, body.needed);
    return { body, headers: res.headers };
  }
}

async function slackPages<T>(method: string, params: Params, key: string): Promise<T[]> {
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

/** Who the bot token acts as, and the scopes Slack reports it holds. */
export interface SlackAuth {
  userId: string;
  botId: string;
  user: string;
  team: string;
  scopes: string[];
}

/** Call `auth.test` with the bot token. Uncached, so a check sees a revoked token. */
export async function slackAuthTest(): Promise<SlackAuth> {
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

let bot: Promise<SlackAuth> | null = null;

/** The factory's own bot, from `auth.test` once per process. */
export function slackBot(): Promise<SlackAuth> {
  bot ??= slackAuthTest().catch((err: unknown) => {
    bot = null;
    throw err;
  });
  return bot;
}

// Slack's own field names: a polled message and a Socket Mode event carry the
// same shape, so one type serves both.
/** A channel message as Slack returns it. */
export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

/** A channel's messages after `oldest` (exclusive), newest first, as Slack returns them. */
export function slackHistory(channel: string, { oldest }: { oldest?: string } = {}) {
  return slackPages<SlackMessage>("conversations.history", { channel, oldest }, "messages");
}

/** A thread: its parent message, then every reply in order. */
export function slackReplies(channel: string, ts: string) {
  return slackPages<SlackMessage>("conversations.replies", { channel, ts }, "messages");
}

/** Post plain `mrkdwn` text, as a reply when `threadTs` is given. Returns the new message's ts. */
export async function slackPostMessage(message: {
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
export async function slackPermalink(channel: string, ts: string): Promise<string> {
  const { body } = await slackCall<SlackReply & { permalink: string }>("chat.getPermalink", {
    channel,
    message_ts: ts,
  });
  return body.permalink;
}

/** A Slack user as jigs names them: display name, else real name, else handle. */
export interface SlackUser {
  id: string;
  name: string;
  email?: string;
  bot: boolean;
}

export async function slackUser(id: string): Promise<SlackUser> {
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
export async function slackOpenConnection(): Promise<string> {
  const { body } = await slackCall<SlackReply & { url: string }>(
    "apps.connections.open",
    {},
    "SLACK_APP_TOKEN",
  );
  return body.url;
}
