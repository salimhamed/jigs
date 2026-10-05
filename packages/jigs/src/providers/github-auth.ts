// The one credential source behind every GitHub call jigs makes: an
// installation token of the factory's GitHub App on the repository owner,
// minted by the hub. Reads the environment and the network, so it is only
// reached from a step, a check or the CLI — never from workflow code.

import type { FactoryContext } from "../config/factory-context.ts";
import { perContext } from "./credentials.ts";
import type { ProviderAuth } from "./http.ts";
import { fetchGithubToken } from "./hub.ts";

/** An installation token lives an hour; renew it while there is still time to fail and retry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The account a GitHub App acts as: `<slug>[bot]`, with that account's user id. */
export interface AppBot {
  login: string;
  id: number;
}

interface IssuedToken {
  token: string;
  expiresAt: number;
  bot: AppBot;
}

export interface GithubAuth extends ProviderAuth {
  /** The bearer token for a REST or GraphQL call, renewed when less than `minLifetimeMs` of it is left. */
  bearer(minLifetimeMs?: number): Promise<string>;
  invalidate(stale: string): void;
  /** The App's bot account on this owner. */
  bot(): Promise<AppBot>;
}

export interface GithubAuthDeps {
  now?: () => number;
  issue(owner: string): Promise<{
    token: string;
    expiresAt: string;
    app: { slug: string; botUserId: number };
  }>;
}

export function createGithubAuth(owner: string, deps: GithubAuthDeps): GithubAuth {
  const now = deps.now ?? Date.now;
  let cached: IssuedToken | null = null;
  // The request in flight, not just the one that finished: a snapshot makes six
  // calls at once, and caching only the result would ask the hub six times.
  let issuing: Promise<IssuedToken> | null = null;
  const fresh = async (minLifetimeMs: number): Promise<IssuedToken> => {
    if (cached !== null && cached.expiresAt - now() > minLifetimeMs) return cached;
    if (issuing === null) {
      issuing = deps
        .issue(owner)
        .then(({ token, expiresAt, app }) => ({
          token,
          expiresAt: Date.parse(expiresAt),
          bot: { login: `${app.slug}[bot]`, id: app.botUserId },
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
    bearer: async (minLifetimeMs = REFRESH_MARGIN_MS) => (await fresh(minLifetimeMs)).token,
    // A late 401 on an old token must not discard one issued since.
    invalidate(stale: string): void {
      if (cached?.token === stale) cached = null;
    },
    bot: async () => (cached ?? (await fresh(REFRESH_MARGIN_MS))).bot,
  };
}

const factoryGithub = perContext((ctx) => ({ ctx, auths: new Map<string, GithubAuth>() }));

/** The credential for one repository owner, created once per factory. */
export function githubAuthFor(owner: string, ctx?: FactoryContext): GithubAuth {
  const github = factoryGithub(ctx);
  const key = owner.toLowerCase();
  let auth = github.auths.get(key);
  if (!auth) {
    auth = createGithubAuth(owner, { issue: (login) => fetchGithubToken(login, github.ctx) });
    github.auths.set(key, auth);
  }
  return auth;
}
