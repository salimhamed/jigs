/**
 * Messages the jigs hub and a factory exchange.
 *
 * @remarks
 * A factory long-polls {@link messagesPath} for its messages, handles them in
 * order, then confirms the last one at {@link cursorPath}. Every request
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
