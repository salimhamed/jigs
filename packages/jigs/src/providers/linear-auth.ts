// The one credential source behind every Linear call jigs makes: an access
// token of the factory's Linear app, handed out by the hub. Reads the
// environment and the network, so it is only reached from a step, a check or
// the CLI — never from workflow code.

import type { FactoryContext } from "../config/factory-context.ts";
import { perContext } from "./credentials.ts";
import type { ProviderAuth } from "./http.ts";
import { fetchLinearToken } from "./hub.ts";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

// The hub refreshes a token with less than five minutes left, so asking again
// at the same margin gets a fresh one.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The user Linear made for the factory's app in a workspace: who jigs is there. */
export interface LinearAppUser {
  id: string;
  name: string;
}

interface IssuedToken {
  token: string;
  expiresAt: number;
  user: LinearAppUser;
}

export interface LinearAuth extends ProviderAuth {
  bearer(): Promise<string>;
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
  const now = deps.now ?? Date.now;
  let cached: IssuedToken | null = null;
  let issuing: Promise<IssuedToken> | null = null;
  const fresh = async (): Promise<IssuedToken> => {
    if (cached !== null && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached;
    if (issuing === null) {
      issuing = deps
        .issue(organization)
        .then(({ token, expiresAt, app }) => ({
          token,
          expiresAt: Date.parse(expiresAt),
          user: { id: app.userId, name: app.name },
        }))
        .finally(() => {
          issuing = null;
        });
    }
    const pending = issuing;
    cached = await pending;
    return cached;
  };
  return {
    bearer: async () => (await fresh()).token,
    // A late rejection of an old token must not discard one issued since.
    invalidate(stale: string): void {
      if (cached?.token === stale) cached = null;
    },
    user: async () => (cached ?? (await fresh())).user,
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
