// The one credential source behind every GitHub call jigs makes: an
// installation token of one of the factory's GitHub App installations, minted
// by the hub. Reads the environment and the network, so it is only reached
// from a step, a check or the CLI — never from workflow code.

import type { FactoryContext } from "../config/factory-context.ts";
import type { HubTokens } from "./credentials.ts";
import type { ProviderAuth } from "./http.ts";
import { installationTokens } from "./installation-tokens.ts";

/** The account a GitHub App acts as: `<slug>[bot]`, with that account's user id. */
export interface AppBot {
  login: string;
  id: number;
}

export interface GithubAuth extends ProviderAuth {
  /** The bearer token for a REST or GraphQL call, renewed when less than `minLifetimeMs` of it is left. */
  bearer(minLifetimeMs?: number): Promise<string>;
  /** The App's bot account. */
  bot(): Promise<AppBot>;
  /** The login of the user or organization the installation is on. */
  account(): Promise<string>;
}

type GithubTokens = Pick<
  HubTokens<{ token: string; account: string; app: { slug: string; botUserId: number } }>,
  "issued" | "bearer" | "invalidate"
>;

export function createGithubAuth(tokens: GithubTokens): GithubAuth {
  return {
    bearer: tokens.bearer,
    invalidate: tokens.invalidate,
    async bot() {
      const { app } = await tokens.issued();
      return { login: `${app.slug}[bot]`, id: app.botUserId };
    },
    account: async () => (await tokens.issued()).account,
  };
}

/** The credential for one GitHub installation. */
export const githubAuthFor = (installationName: string, ctx?: FactoryContext): GithubAuth =>
  createGithubAuth(installationTokens("github", installationName, ctx));
