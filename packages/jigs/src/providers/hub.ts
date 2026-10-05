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
  type SlackTokenRequest,
  type SlackTokenResponse,
  slackTokenPath,
} from "@jigs-ai/hub-protocol";
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

async function hubSend<T>(
  ctx: FactoryContext,
  apiPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = ctx.env("JIGS_HUB_TOKEN");
  if (token === undefined || token === "")
    throw new JigsError("JIGS_HUB_TOKEN is not set", HUB_CONNECT);
  const response = await hubRequest({ url: ctx.config.hub.url, token }, apiPath, init);
  return (await response.json()) as T;
}

/** Who this factory is on its hub, and the apps assigned to it. */
export function fetchFactoryStatus(ctx: FactoryContext = currentFactoryContext()) {
  return hubSend<FactoryStatus>(ctx, factoryStatusPath);
}

/** An installation token of the factory's GitHub App installed on `owner`. */
export async function fetchGithubToken(
  owner: string,
  ctx: FactoryContext = currentFactoryContext(),
): Promise<GitHubTokenResponse> {
  try {
    return await hubSend<GitHubTokenResponse>(ctx, githubTokenPath, {
      method: "POST",
      body: { owner } satisfies GitHubTokenRequest,
    });
  } catch (error) {
    if (error instanceof HubResponseError && (error.status === 404 || error.status === 409))
      throw new HubResponseError(
        error.status,
        error.message,
        error.status === 404
          ? `in the hub, install one of this factory's GitHub Apps on ${owner}, or assign the factory an App installed there`
          : `in the hub, leave this factory assigned only one App installed on ${owner}`,
      );
    throw error;
  }
}

/**
 * An access token of the factory's Linear app in a connected workspace: the one `organization`
 * names (an organization id or URL key), or the only one when it is left out.
 */
export async function fetchLinearToken(
  organization: string | undefined,
  ctx: FactoryContext = currentFactoryContext(),
): Promise<LinearTokenResponse> {
  try {
    return await hubSend<LinearTokenResponse>(ctx, linearTokenPath, {
      method: "POST",
      body: (organization === undefined ? {} : { organization }) satisfies LinearTokenRequest,
    });
  } catch (error) {
    if (error instanceof HubResponseError && error.status in LINEAR_TOKEN_REPAIRS)
      throw new HubResponseError(
        error.status,
        error.message,
        LINEAR_TOKEN_REPAIRS[error.status as keyof typeof LINEAR_TOKEN_REPAIRS],
      );
    throw error;
  }
}

const LINEAR_TOKEN_REPAIRS = {
  404: "in the hub, connect a Linear workspace to one of this factory's Linear apps, or assign the factory an app connected there",
  409: "in the hub, leave this factory assigned one Linear app, connected to one workspace",
  503: "in the hub, connect the Linear workspace again: Linear refused to refresh the app's access",
};

/** The bot token of the factory's Slack app in the one workspace it is installed in. */
export async function fetchSlackToken(
  ctx: FactoryContext = currentFactoryContext(),
): Promise<SlackTokenResponse> {
  try {
    return await hubSend<SlackTokenResponse>(ctx, slackTokenPath, {
      method: "POST",
      body: {} satisfies SlackTokenRequest,
    });
  } catch (error) {
    if (error instanceof HubResponseError && (error.status === 404 || error.status === 409))
      throw new HubResponseError(
        error.status,
        error.message,
        error.status === 404
          ? "in the hub, install one of this factory's Slack apps in the workspace, or assign the factory a Slack app installed there"
          : "in the hub, leave this factory assigned one Slack app, installed in one workspace",
      );
    throw error;
  }
}
