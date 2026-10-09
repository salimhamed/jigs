// Every Slack Web API call jigs makes, and the one transport a factory's own
// `callSlack` goes through. A factory's Slack app always acts as itself, with
// the bot token the hub hands out for the workspace. Reaches the hub and Slack,
// so it is called from a step, a check or the service, never from workflow code.

import {
  currentFactoryContext,
  type FactoryContext,
  runSignal,
} from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import type { JsonValue } from "../workflow/human/questions.ts";
import { ProviderApiError, rateLimitWaits, retryAfterSeconds } from "./http.ts";
import { installationTokens } from "./installation-tokens.ts";

export const SLACK_API_URL = "https://slack.com/api";

// What Slack answers a bot token it no longer takes, such as one revoked by
// reinstalling the app: the hub may already hold its successor.
const STALE_TOKEN = new Set(["invalid_auth", "token_revoked"]);

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
  /** The Slack installation, as named on the hub, whose bot token it sends. */
  installationName: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The factory whose token it sends. Defaults to the process's own, resolved on each call. */
  context?: FactoryContext;
}

/** The factory's Slack app in one workspace: its bot user, and the scopes the workspace granted. */
export interface SlackBot {
  userId: string;
  /** The app's id, which its posts carry as `app_id` even without a user. */
  appId: string;
  name: string;
  team: string;
  scopes: string[];
}

/** A channel message as Slack returns it. */
export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
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

export function createSlackClient(deps: SlackClientDeps) {
  const ctx = () => deps.context ?? currentFactoryContext();
  // Form-encoded, because every Web API method accepts it and not every read
  // method accepts JSON.
  async function slackCall<T extends SlackReply>(
    method: string,
    params: SlackParams = {},
  ): Promise<{ body: T; headers: Headers }> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined)
        form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const rateLimit = rateLimitWaits("slack", runSignal, deps.sleep);
    const tokens = installationTokens("slack", deps.installationName, ctx());
    let reissued = false;
    for (;;) {
      const { token } = await tokens.issued();
      const res = await (deps.fetch ?? fetch)(`${SLACK_API_URL}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      const text = await res.text();
      if (res.status === 429 && (await rateLimit.wait(retryAfterSeconds(res)))) continue;
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
        if (!reissued && STALE_TOKEN.has(body.error ?? "")) {
          tokens.invalidate(token);
          reissued = true;
          continue;
        }
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

  return {
    slackCall,
    slackReplies,
    slackPostMessage,
    slackPermalink,
    slackUser,
  };
}

export type SlackClient = ReturnType<typeof createSlackClient>;

/** The factory's Slack client for one installation. */
export const slackFor = (installationName: string, context?: FactoryContext): SlackClient =>
  createSlackClient({ installationName, ...(context === undefined ? {} : { context }) });

/** The factory's own bot in one installation. */
export async function slackBot(installationName: string, ctx?: FactoryContext): Promise<SlackBot> {
  const { app, team, scopes } = await installationTokens("slack", installationName, ctx).issued();
  return { userId: app.botUserId, appId: app.appId, name: app.name, team, scopes };
}
