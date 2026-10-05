// The one credential source behind every Linear call jigs makes: an access
// token of the factory's Linear app, handed out by the hub. Reads the
// environment and the network, so it is only reached from a step, a check or
// the CLI — never from workflow code.

import type { FactoryContext } from "../config/factory-context.ts";
import { createHubTokens, perContext } from "./credentials.ts";
import type { ProviderAuth } from "./http.ts";
import { fetchLinearToken } from "./hub.ts";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

/** The user Linear made for the factory's app in a workspace: who jigs is there. */
export interface LinearAppUser {
  id: string;
  name: string;
}

export interface LinearAuth extends ProviderAuth {
  /** The bearer token, asked of the hub again when less than `minLifetimeMs` of it is left. */
  bearer(minLifetimeMs?: number): Promise<string>;
  invalidate(stale: string): void;
  /** The app's own user in the workspace. */
  user(): Promise<LinearAppUser>;
}

export interface LinearAuthDeps {
  now?: () => number;
  issue(organization: string | undefined): Promise<{
    token: string;
    expiresAt: string;
    app: { name: string; userId: string };
  }>;
}

/** The credential for one workspace, or for the only one when `organization` is left out. */
export function createLinearAuth(
  organization: string | undefined,
  deps: LinearAuthDeps,
): LinearAuth {
  const tokens = createHubTokens(() => deps.issue(organization), deps.now);
  return {
    bearer: tokens.bearer,
    invalidate: tokens.invalidate,
    async user() {
      const { app } = await tokens.issued();
      return { id: app.userId, name: app.name };
    },
  };
}

const factoryLinear = perContext((ctx) => ({
  ctx,
  auths: new Map<string | undefined, LinearAuth>(),
}));

/** The factory's Linear credential for one workspace, created once per factory. */
export function linearAuthFor(ctx?: FactoryContext, organization?: string): LinearAuth {
  const linear = factoryLinear(ctx);
  let auth = linear.auths.get(organization);
  if (!auth) {
    auth = createLinearAuth(organization, {
      issue: (named) => fetchLinearToken(named, linear.ctx),
    });
    linear.auths.set(organization, auth);
  }
  return auth;
}
