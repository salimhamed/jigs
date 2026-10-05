// The factory's requests to its hub beyond the message loop: who it is there,
// and the provider tokens the hub mints for it.

import {
  type FactoryStatus,
  factoryStatusPath,
  type GitHubTokenRequest,
  type GitHubTokenResponse,
  githubTokenPath,
  type LinearTokenRequest,
  type LinearTokenResponse,
  linearTokenPath,
  type PagerDutyTokenResponse,
  type Provider,
  pagerDutyTokenPath,
  type SlackTokenResponse,
  slackTokenPath,
} from "@jigs-ai/hub-protocol";
import type { CheckResult } from "../checks/check.ts";
import { currentFactoryContext, type FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { JIGS_VERSION } from "../version.ts";

const HUB_TIMEOUT_MS = 30_000;

export const HUB_CONNECT =
  "connect the factory with the token the hub showed when you added it: `pnpm exec jigs hub connect <url> <token>`";

/** The hub answered with an error status. */
export class HubResponseError extends JigsError {
  readonly status: number;
  constructor(status: number, message: string, hint?: string) {
    super(message, hint);
    this.status = status;
  }
}

/** Where the hub is and the factory's token for it. */
export interface HubConnection {
  url: string;
  token: string;
}

/**
 * One request to the hub, with the factory's token and jigs' version. Every call the factory makes
 * to its hub goes through here; an error status throws a {@link HubResponseError}.
 */
export async function hubRequest(
  hub: HubConnection,
  apiPath: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const url = new URL(apiPath, hub.url);
  const method = init.method ?? "GET";
  const timeout = AbortSignal.timeout(init.timeoutMs ?? HUB_TIMEOUT_MS);
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${hub.token}`,
      "user-agent": `jigs/${JIGS_VERSION}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]),
  });
  if (response.ok) return response;
  if (response.status === 401)
    throw new HubResponseError(
      401,
      `the hub at ${url.origin} rejected JIGS_HUB_TOKEN`,
      HUB_CONNECT,
    );
  const text = await response.text();
  let reason = text.slice(0, 500);
  try {
    reason = (JSON.parse(text) as { error?: string }).error ?? reason;
  } catch {}
  throw new HubResponseError(
    response.status,
    `the hub answered ${response.status} to ${method} ${apiPath}${reason === "" ? "" : `: ${reason}`}`,
  );
}

/** Where this factory's hub is and its token there; throws when the factory is not connected. */
export function hubConnection(ctx: FactoryContext): HubConnection {
  const token = ctx.env("JIGS_HUB_TOKEN");
  if (token === undefined) throw new JigsError("JIGS_HUB_TOKEN is not set", HUB_CONNECT);
  return { url: ctx.config.hub.url, token };
}

async function hubSend<T>(
  ctx: FactoryContext,
  apiPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await hubRequest(hubConnection(ctx), apiPath, init);
  return (await response.json()) as T;
}

/** A failed check for a hub request that failed: what was asked, why, and the hub's repair when it named one. */
export function hubRefused(asked: string, err: unknown): CheckResult {
  return {
    ok: false,
    reason: `${asked}: ${err instanceof Error ? err.message : String(err)}`,
    repair:
      (err instanceof JigsError ? err.hint : undefined) ??
      "check hub.url in jigs.config.ts and that the hub is running, then: `pnpm exec jigs doctor`",
  };
}

/** Who this factory is on its hub, and the apps assigned to it. */
export function fetchFactoryStatus(ctx: FactoryContext = currentFactoryContext()) {
  return hubSend<FactoryStatus>(ctx, factoryStatusPath);
}

/** What the factory asks the hub for each provider's token, and what it gets back. */
export interface HubTokenExchange {
  github: { request: GitHubTokenRequest; response: GitHubTokenResponse };
  linear: { request: LinearTokenRequest; response: LinearTokenResponse };
  slack: { request: Record<string, never>; response: SlackTokenResponse };
  pagerduty: { request: Record<string, never>; response: PagerDutyTokenResponse };
}

type HintsByStatus = Partial<Record<number, string>>;

const HUB_TOKENS: {
  [P in Provider]: { path: string; hints(request: HubTokenExchange[P]["request"]): HintsByStatus };
} = {
  github: {
    path: githubTokenPath,
    hints: ({ owner }) => ({
      404: `in the hub, install one of this factory's GitHub Apps on ${owner}, or assign the factory an App installed there`,
      409: `in the hub, leave this factory assigned only one App installed on ${owner}`,
    }),
  },
  linear: {
    path: linearTokenPath,
    hints: () => ({
      404: "in the hub, connect a Linear workspace to one of this factory's Linear apps, or assign the factory an app connected there",
      409: "in the hub, leave this factory assigned one Linear app, connected to one workspace",
      503: "in the hub, connect the Linear workspace again: Linear refused to refresh the app's access",
    }),
  },
  slack: {
    path: slackTokenPath,
    hints: () => ({
      404: "in the hub, install one of this factory's Slack apps in the workspace, or assign the factory a Slack app installed there",
      409: "in the hub, leave this factory assigned one Slack app, installed in one workspace",
    }),
  },
  pagerduty: {
    path: pagerDutyTokenPath,
    hints: () => ({
      404: "in the hub, assign this factory a PagerDuty app",
      409: "in the hub, leave this factory assigned only one PagerDuty app",
      503: "PagerDuty refused the hub's credentials for this factory's PagerDuty app: in the hub, remove the app and add it again with its current client id and secret",
    }),
  },
};

/**
 * A token the hub mints for the factory's app of `provider`: GitHub's for the repository owner
 * `request` names, Linear's for the workspace it names or the only one.
 */
export async function hubToken<P extends Provider>(
  provider: P,
  request: HubTokenExchange[P]["request"],
  ctx: FactoryContext = currentFactoryContext(),
): Promise<HubTokenExchange[P]["response"]> {
  const { path, hints } = HUB_TOKENS[provider];
  try {
    return await hubSend(ctx, path, { method: "POST", body: request });
  } catch (error) {
    if (!(error instanceof HubResponseError)) throw error;
    const hint = hints(request)[error.status];
    if (hint === undefined) throw error;
    throw new HubResponseError(error.status, error.message, hint);
  }
}
