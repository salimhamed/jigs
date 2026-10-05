// The one credential source behind every GitHub call jigs makes: an
// installation token of the factory's GitHub App on the repository owner,
// minted by the hub. Reads the environment and the network, so it is only
// reached from a step, a check or the CLI — never from workflow code.

import type { FactoryContext } from "../config/factory-context.ts";
import { createHubTokens, perContext } from "./credentials.ts";
import type { ProviderAuth } from "./http.ts";
import { hubToken } from "./hub.ts";

/** The account a GitHub App acts as: `<slug>[bot]`, with that account's user id. */
export interface AppBot {
  login: string;
  id: number;
}

export interface GithubAuth extends ProviderAuth {
  /** The bearer token for a REST or GraphQL call, renewed when less than `minLifetimeMs` of it is left. */
  bearer(minLifetimeMs?: number): Promise<string>;
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
  const tokens = createHubTokens(() => deps.issue(owner), deps.now);
  return {
    bearer: tokens.bearer,
    invalidate: tokens.invalidate,
    async bot() {
      const { app } = await tokens.issued();
      return { login: `${app.slug}[bot]`, id: app.botUserId };
    },
  };
}

const factoryGithub = perContext((ctx) => ({ ctx, auths: new Map<string, GithubAuth>() }));

/** The credential for one repository owner, created once per factory. */
export function githubAuthFor(owner: string, ctx?: FactoryContext): GithubAuth {
  const github = factoryGithub(ctx);
  const key = owner.toLowerCase();
  let auth = github.auths.get(key);
  if (!auth) {
    auth = createGithubAuth(owner, {
      issue: (login) => hubToken("github", { owner: login }, github.ctx),
    });
    github.auths.set(key, auth);
  }
  return auth;
}
