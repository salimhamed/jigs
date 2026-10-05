// The factory's requests to its hub beyond the message loop: who it is there,
// and the provider tokens the hub mints for it.

import {
  type FactoryStatus,
  factoryStatusPath,
  type GitHubTokenRequest,
  type GitHubTokenResponse,
  githubTokenPath,
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

async function hubSend<T>(
  ctx: FactoryContext,
  apiPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = ctx.env("JIGS_HUB_TOKEN");
  if (token === undefined || token === "")
    throw new JigsError("JIGS_HUB_TOKEN is not set", HUB_CONNECT);
  const url = new URL(apiPath, ctx.config.hub.url);
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": `jigs/${JIGS_VERSION}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (response.ok) return (await response.json()) as T;
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
    `the hub answered ${response.status} to ${init.method ?? "GET"} ${apiPath}${reason === "" ? "" : `: ${reason}`}`,
  );
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
