// A thin client for the PagerDuty REST API: only the calls jigs makes, with
// PagerDuty's own field and parameter names. It acts as the factory's
// PagerDuty app, with a token the hub hands out. These reach the hub and the
// network, so a caller reaches them from a step, a check or the service —
// never from a workflow body.

import {
  currentFactoryContext,
  type FactoryContext,
  runSignal,
} from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import type { HubTokens } from "./credentials.ts";
import { MAX_RATE_LIMIT_WAIT_SECONDS, ProviderApiError, rateLimitWaits } from "./http.ts";
import { installationTokens } from "./installation-tokens.ts";

export const PAGERDUTY_API_URL = "https://api.pagerduty.com";

const PAGE_LIMIT = 100;
// PagerDuty's offset pagination stops at 10,000 records; past that a query
// needs narrowing, not more pages.
const MAX_PAGES = 100;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5;

export interface PagerDutyReference {
  id: string;
  type?: string;
  summary?: string;
  html_url?: string;
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
  assignments: Array<{ at?: string; assignee: PagerDutyReference }>;
  escalation_policy: PagerDutyReference;
}

export interface PagerDutyNote {
  id: string;
  content: string;
  created_at: string;
  user: PagerDutyReference;
}

export interface PagerDutyUser {
  id: string;
  name: string;
  email: string;
}

export interface PagerDutyClient {
  getIncident(id: string): Promise<PagerDutyIncident>;
  /** Add a note to an incident, attributed to the installation's from user. */
  createNote(incidentId: string, content: string): Promise<PagerDutyNote>;
  findUserByEmail(email: string): Promise<PagerDutyUser | null>;
  /** The cheapest read that proves the token works: one incident, if any. */
  verifyAccess(): Promise<void>;
}

/** The tokens of one of the factory's PagerDuty installations, as the hub hands them out. */
export type PagerDutyTokens = Pick<
  HubTokens<{ token: string; from: string }>,
  "issued" | "invalidate"
>;

export interface PagerDutyClientDeps {
  /** The PagerDuty installation, as named on the hub, the client acts through. */
  installationName: string;
  tokens?: PagerDutyTokens;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The factory it acts for. Defaults to the process's own, resolved on each call. */
  context?: FactoryContext;
}

function queryString(query: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) params.append(name, String(value));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

function rateLimitResetSeconds(res: Response): number {
  const reset = Number(res.headers.get("ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : DEFAULT_RATE_LIMIT_WAIT_SECONDS;
}

export function createPagerDutyClient(deps: PagerDutyClientDeps): PagerDutyClient {
  const ctx = () => deps.context ?? currentFactoryContext();

  async function request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const url = `${PAGERDUTY_API_URL}${apiPath}`;
    const tokens = deps.tokens ?? installationTokens("pagerduty", deps.installationName, ctx());
    let reauthorized = false;
    const rateLimit = rateLimitWaits("pagerduty", runSignal, deps.sleep);
    for (;;) {
      const { token: credential, from } = await tokens.issued();
      const res = await (deps.fetch ?? fetch)(url, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          accept: "application/vnd.pagerduty+json;version=2",
          // PagerDuty refuses a write that names no user (error 1027).
          ...(method === "GET" ? {} : { from }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status === 401 && !reauthorized) {
        tokens.invalidate(credential);
        reauthorized = true;
        continue;
      }
      let detail: string | undefined;
      if (res.status === 429) {
        const seconds = rateLimitResetSeconds(res);
        if (await rateLimit.wait(seconds)) continue;
        if (seconds > MAX_RATE_LIMIT_WAIT_SECONDS) detail = `rate limited for ${seconds}s`;
      }
      if (!res.ok) {
        throw new ProviderApiError({
          provider: "pagerduty",
          status: res.status,
          request: `${method} ${new URL(url).pathname}`,
          body: text,
          detail,
        });
      }
      return (res.status === 204 || text === "" ? undefined : JSON.parse(text)) as T;
    }
  }

  async function listAll<T>(
    apiPath: string,
    key: string,
    query: Record<string, string> = {},
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
      "narrow the query so it matches fewer records",
    );
  }

  return {
    async getIncident(id) {
      const reply = await request<{ incident: PagerDutyIncident }>(
        "GET",
        `/incidents/${encodeURIComponent(id)}`,
      );
      return reply.incident;
    },
    async createNote(incidentId, content) {
      const reply = await request<{ note: PagerDutyNote }>(
        "POST",
        `/incidents/${encodeURIComponent(incidentId)}/notes`,
        { note: { content } },
      );
      return reply.note;
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

/** The factory's PagerDuty client for one installation. */
export const pagerDutyFor = (installationName: string, context?: FactoryContext): PagerDutyClient =>
  createPagerDutyClient({ installationName, ...(context === undefined ? {} : { context }) });
