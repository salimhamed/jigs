// The factory's requests to its hub beyond the message loop: who it is there,
// and the provider tokens the hub mints for it.

import {
  type FactoryStatus,
  factoryStatusPath,
  type GitHubTokenResponse,
  githubTokenPath,
  type LinearTokenResponse,
  linearTokenPath,
  type PagerDutyTokenResponse,
  type Provider,
  pagerDutyTokenPath,
  type SlackTokenResponse,
  slackTokenPath,
  type TokenRequest,
} from "@jigs-ai/hub-protocol";
import type { CheckResult } from "../checks/check.ts";
import { currentFactoryContext, type FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import { JIGS_VERSION } from "../version.ts";

const HUB_TIMEOUT_MS = 30_000;

export const HUB_CONNECT =
  "set JIGS_HUB_TOKEN in the factory's environment to the token the hub showed when you added this factory";

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

/** What the hub answers each provider's token request with. */
export interface HubTokenResponses {
  github: GitHubTokenResponse;
  linear: LinearTokenResponse;
  slack: SlackTokenResponse;
  pagerduty: PagerDutyTokenResponse;
}

const TOKEN_PATHS: Record<Provider, string> = {
  github: githubTokenPath,
  linear: linearTokenPath,
  slack: slackTokenPath,
  pagerduty: pagerDutyTokenPath,
};

/** Each provider's name as people write it. */
export const PROVIDER_NAMES: Record<Provider, string> = {
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  pagerduty: "PagerDuty",
};

/** A token the hub mints for the factory on the installation named `installationName`. */
export async function hubToken<P extends Provider>(
  provider: P,
  installationName: string,
  ctx: FactoryContext = currentFactoryContext(),
): Promise<HubTokenResponses[P]> {
  try {
    return await hubSend(ctx, TOKEN_PATHS[provider], {
      method: "POST",
      body: { installationName } satisfies TokenRequest,
    });
  } catch (error) {
    if (!(error instanceof HubResponseError) || error.status !== 404) throw error;
    throw new HubResponseError(
      404,
      error.message,
      `in the hub, name a ${PROVIDER_NAMES[provider]} installation ${installationName} and assign its app to this factory, or use the name of one that is`,
    );
  }
}
