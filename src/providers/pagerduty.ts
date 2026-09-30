// A thin client for the PagerDuty REST API: only the calls jigs makes, with
// PagerDuty's own field and parameter names. These read env and hit the
// network, so a caller reaches them from a step, a check or the service —
// never from a workflow body.

import type { PagerDutyIdentity } from "../config/factory-config.ts";
import { JigsError } from "../errors.ts";
import { type PagerDutyAuth, pagerDutyAuthFor } from "./pagerduty-auth.ts";

export const PAGERDUTY_API_URL = "https://api.pagerduty.com";

const PAGE_LIMIT = 100;
// PagerDuty's offset pagination stops at 10,000 records; past that a query
// needs narrowing, not more pages.
const MAX_PAGES = 100;
const RATE_LIMIT_RETRIES = 3;
// A wait longer than this belongs to the caller's schedule, not a blocked call.
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5;
const MAX_ERROR_BODY = 1_000;

export interface PagerDutyReference {
  id: string;
  type?: string;
  summary?: string;
}

export interface PagerDutyIncident {
  id: string;
  incident_number: number;
  title: string;
  status: "triggered" | "acknowledged" | "resolved";
  urgency: "high" | "low";
  created_at: string;
  html_url: string;
  service: PagerDutyReference;
}

export interface PagerDutyNote {
  id: string;
  content: string;
  created_at: string;
  user: PagerDutyReference;
}

export interface PagerDutyWebhookSubscription {
  id: string;
  active: boolean;
  events: string[];
  delivery_method: { type: string; url: string };
  filter: { type: string; id?: string };
}

export interface PagerDutyUser {
  id: string;
  name: string;
  email: string;
}

type QueryValue = string | number | boolean | readonly string[];

/**
 * Query parameters under PagerDuty's own names; an array is sent as `name[]` once per value.
 * Paging is the client's, so `limit` and `offset` are not accepted.
 */
export type PagerDutyQuery = Record<string, QueryValue> & { limit?: never; offset?: never };

/** What to keep from the full webhook subscription list. */
export interface WebhookSubscriptionMatch {
  url?: string;
  filter?: { type?: string; id?: string };
}

// Carries the status and body so a caller can tell a rejected token, a missing
// scope and a rate limit apart.
export class PagerDutyApiError extends JigsError {
  readonly status: number;

  constructor(status: number, request: string, body: string, detail?: string) {
    super(`PagerDuty API ${status} on ${request}: ${detail ?? body.slice(0, MAX_ERROR_BODY)}`);
    this.status = status;
  }
}

export interface PagerDutyClient {
  identity: PagerDutyIdentity;
  getIncident(id: string): Promise<PagerDutyIncident>;
  listIncidents(query?: PagerDutyQuery): Promise<PagerDutyIncident[]>;
  /** Add a note to an incident, attributed to the identity's `from` user. */
  createNote(incidentId: string, content: string): Promise<PagerDutyNote>;
  /** Every subscription on the account, narrowed here: PagerDuty refuses its own filter parameters. */
  listWebhookSubscriptions(
    match?: WebhookSubscriptionMatch,
  ): Promise<PagerDutyWebhookSubscription[]>;
  findUserByEmail(email: string): Promise<PagerDutyUser | null>;
  /** The cheapest read that proves the token works: one incident, if any. */
  verifyAccess(): Promise<void>;
}

export interface PagerDutyClientDeps {
  auth?: PagerDutyAuth;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function queryString(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const entry of value) params.append(`${name}[]`, entry);
    else params.append(name, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function rateLimitWaitSeconds(res: Response): number {
  const reset = Number(res.headers.get("ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : DEFAULT_RATE_LIMIT_WAIT_SECONDS;
}

export function createPagerDutyClient(
  identity: PagerDutyIdentity,
  deps: PagerDutyClientDeps = {},
): PagerDutyClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const auth = (): PagerDutyAuth => deps.auth ?? pagerDutyAuthFor();

  async function request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const label = `${method} ${apiPath.split("?")[0]}`;
    let reauthorized = false;
    let rateLimited = 0;
    for (;;) {
      const token = await auth().bearer();
      const res = await doFetch(`${PAGERDUTY_API_URL}${apiPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.pagerduty+json;version=2",
          // PagerDuty refuses a write that names no user (error 1027).
          ...(method === "GET" ? {} : { from: identity.from }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
      const text = await res.text();
      // A day-long token can be revoked early, by a re-mint with other scopes.
      if (res.status === 401 && !reauthorized) {
        reauthorized = true;
        auth().invalidate(token);
        continue;
      }
      if (res.status === 429) {
        const wait = rateLimitWaitSeconds(res);
        if (wait > MAX_RATE_LIMIT_WAIT_SECONDS) {
          throw new PagerDutyApiError(429, label, text, `rate limited for ${wait}s`);
        }
        if (rateLimited < RATE_LIMIT_RETRIES) {
          rateLimited += 1;
          await sleep(wait * 1000);
          continue;
        }
      }
      throw new PagerDutyApiError(res.status, label, text);
    }
  }

  async function listAll<T>(
    apiPath: string,
    key: string,
    query: PagerDutyQuery = {},
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const reply = await request<Record<string, unknown> & { more?: boolean }>(
        "GET",
        `${apiPath}${queryString({ ...query, limit: PAGE_LIMIT, offset: all.length })}`,
      );
      // PagerDuty may cap a page below the limit asked for, so the next
      // offset is what has arrived; an empty page claiming more would spin.
      const batch = (reply[key] as T[] | undefined) ?? [];
      all.push(...batch);
      if (reply.more !== true || batch.length === 0) return all;
    }
    throw new JigsError(
      `PagerDuty kept reporting more ${key} past ${MAX_PAGES * PAGE_LIMIT} records on ${apiPath}`,
      "narrow the query, for example with a later since or fewer statuses, so it matches fewer records",
    );
  }

  return {
    identity,
    async getIncident(id) {
      const reply = await request<{ incident: PagerDutyIncident }>(
        "GET",
        `/incidents/${encodeURIComponent(id)}`,
      );
      return reply.incident;
    },
    listIncidents: (query = {}) => listAll<PagerDutyIncident>("/incidents", "incidents", query),
    async createNote(incidentId, content) {
      const reply = await request<{ note: PagerDutyNote }>(
        "POST",
        `/incidents/${encodeURIComponent(incidentId)}/notes`,
        { note: { content } },
      );
      return reply.note;
    },
    async listWebhookSubscriptions(match = {}) {
      const all = await listAll<PagerDutyWebhookSubscription>(
        "/webhook_subscriptions",
        "webhook_subscriptions",
      );
      return all.filter(
        (entry) =>
          (match.url === undefined || entry.delivery_method.url === match.url) &&
          (match.filter?.type === undefined || entry.filter.type === match.filter.type) &&
          (match.filter?.id === undefined || entry.filter.id === match.filter.id),
      );
    },
    async findUserByEmail(email) {
      // `query` also matches names and email prefixes, so the match is made here.
      const users = await listAll<PagerDutyUser>("/users", "users", { query: email });
      return users.find((user) => user.email.toLowerCase() === email.toLowerCase()) ?? null;
    },
    async verifyAccess() {
      await request("GET", `/incidents${queryString({ limit: 1 })}`);
    },
  };
}

let processClient: { auth: PagerDutyAuth; client: PagerDutyClient } | null = null;

/** This process's PagerDuty client, for the factory's configured identity. */
export function pagerDutyClientFor(): PagerDutyClient {
  const auth = pagerDutyAuthFor();
  if (processClient?.auth !== auth) {
    processClient = { auth, client: createPagerDutyClient(auth.identity, { auth }) };
  }
  return processClient.client;
}
