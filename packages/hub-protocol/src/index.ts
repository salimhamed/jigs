/**
 * Messages the jigs hub and a factory exchange.
 *
 * @remarks
 * A factory long-polls {@link messagesPath} for its messages, handles them in
 * order, then confirms the last one at {@link cursorPath}. It retries an event
 * it could not handle a few times before confirming past it. Every request
 * carries `Authorization: Bearer <factory token>` and `User-Agent:
 * jigs/<version>`; the hub answers 401 to a missing or unknown token.
 *
 * @packageDocumentation
 */

/** The providers whose events the hub receives. */
export const providers = ["github", "linear", "slack", "pagerduty"] as const;

/** One of {@link providers}. */
export type Provider = (typeof providers)[number];

/** One event the hub received from a provider and stored. */
export interface ProviderEvent {
  /** The hub's id for the stored event. */
  id: string;
  provider: Provider;
  /** GitHub's `X-GitHub-Event` header; for the others, the payload's own event type. */
  name: string;
  /** When the hub received it, as an ISO 8601 timestamp. */
  receivedAt: string;
  /** The provider's JSON body, as received. */
  payload: unknown;
}

/** Every kind of message on the hub connection. */
export const messageKinds = ["event", "fellBehind"] as const;

/** One kind of message on the hub connection. */
export type MessageKind = (typeof messageKinds)[number];

/**
 * One message for a factory. `position` orders every message and is what the
 * factory confirms; it is a decimal string because it can exceed a JavaScript
 * number. `fellBehind` means the hub deleted messages the factory never
 * confirmed, so the factory should wake every waiting run.
 */
export type Message =
  | { position: string; kind: "event"; event: ProviderEvent }
  | { position: string; kind: "fellBehind" };

/**
 * `GET` returns {@link MessagesResponse}: the messages after the confirmed
 * cursor, oldest first. With `?wait=<seconds>` the hub holds the request until
 * a message arrives or the wait ends.
 */
export const messagesPath = "/api/factory/messages";

/** The longest `wait`, in seconds, the hub honors on {@link messagesPath}. */
export const maxWaitSeconds = 30;

/** The most messages one {@link messagesPath} response holds. */
export const maxMessagesPerResponse = 100;

/** The body of a {@link messagesPath} response. */
export interface MessagesResponse {
  messages: Message[];
}

/**
 * `POST` a {@link CursorRequest} to confirm every message up to and including
 * its position; the hub answers 204. A position below the stored one is
 * ignored.
 */
export const cursorPath = "/api/factory/cursor";

/** The body of a {@link cursorPath} request. */
export interface CursorRequest {
  position: string;
}

/**
 * `GET` returns {@link FactoryStatus}: who the factory is on the hub and the
 * apps assigned to it.
 */
export const factoryStatusPath = "/api/factory/status";

/** The body of a {@link factoryStatusPath} response. Lists only the apps assigned to the factory. */
export interface FactoryStatus {
  factory: { name: string };
  organization: { name: string };
  apps: {
    provider: Provider;
    name: string;
    /** The accounts or workspaces the app is installed on. */
    installations: { account: string }[];
  }[];
}

/**
 * `POST` a {@link GitHubTokenRequest} for a {@link GitHubTokenResponse}: an
 * installation token of the GitHub App assigned to the factory that is
 * installed on the owner. The hub answers 404 when no assigned App is
 * installed there, and 409 when more than one is.
 */
export const githubTokenPath = "/api/factory/tokens/github";

/** The body of a {@link githubTokenPath} request. */
export interface GitHubTokenRequest {
  /** The login of the repository owner, a user or an organization. */
  owner: string;
}

/** The body of a {@link githubTokenPath} response. */
export interface GitHubTokenResponse {
  token: string;
  /** When the token stops working, as an ISO 8601 timestamp. */
  expiresAt: string;
  /** The App the token acts as; it commits as `<slug>[bot]` with the bot's user id. */
  app: { slug: string; botUserId: number };
}

/**
 * `POST` a {@link LinearTokenRequest} for a {@link LinearTokenResponse}: the
 * access token of a Linear workspace connected to a Linear app assigned to the
 * factory. The hub answers 404 when there is no such workspace, 409 when the
 * request matches more than one, and 503 when the workspace must be connected
 * again on the hub.
 */
export const linearTokenPath = "/api/factory/tokens/linear";

/** The body of a {@link linearTokenPath} request. */
export interface LinearTokenRequest {
  /** The workspace's Linear organization id or URL key; may be left out when only one is connected. */
  organization?: string;
}

/** The body of a {@link linearTokenPath} response. */
export interface LinearTokenResponse {
  token: string;
  /** When the token stops working, as an ISO 8601 timestamp. */
  expiresAt: string;
  /** The app the token acts as, and the id of the user Linear made for it in that workspace. */
  app: { name: string; userId: string };
}

/**
 * `POST` a {@link SlackTokenRequest} for a {@link SlackTokenResponse}: the bot
 * token of a Slack workspace where a Slack app assigned to the factory is
 * installed. The hub answers 404 when there is no such installation and 409
 * when the request matches more than one.
 */
export const slackTokenPath = "/api/factory/tokens/slack";

/** The body of a {@link slackTokenPath} request. Both fields are on every Slack event; either may be left out when only one installation matches. */
export interface SlackTokenRequest {
  /** The Slack app's id, an event's `api_app_id`. */
  appId?: string;
  /** The workspace's id, an event's `team_id`. */
  team?: string;
}

/** The bot token scopes every factory's Slack app needs; a factory may need more. */
export const slackBotScopes = [
  "channels:history",
  "groups:history",
  "chat:write",
  "users:read",
  "users:read.email",
] as const;

/** The body of a {@link slackTokenPath} response. */
export interface SlackTokenResponse {
  /** The bot token, which does not expire. */
  token: string;
  /** The bot token scopes the workspace granted. */
  scopes: string[];
  /** The app the token acts as and the user id of its bot in the workspace. */
  app: { appId: string; name: string; botUserId: string };
  /** The workspace's id. */
  team: string;
}

/**
 * `POST` an empty object for a {@link PagerDutyTokenResponse}: a fresh token
 * of the one PagerDuty app assigned to the factory, acting as the app in its
 * account. The hub answers 404 when none is, 409 when several are, and 503
 * when PagerDuty refuses the app's credentials.
 */
export const pagerDutyTokenPath = "/api/factory/tokens/pagerduty";

/** The scopes a PagerDuty app grants a factory, besides its account. */
export const pagerDutyScopes = ["incidents.read", "incidents.write", "users.read"] as const;

/** The body of a {@link pagerDutyTokenPath} response. */
export interface PagerDutyTokenResponse {
  token: string;
  /** When the token stops working, as an ISO 8601 timestamp. */
  expiresAt: string;
}
