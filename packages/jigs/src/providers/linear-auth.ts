// The one credential source behind every Linear call jigs makes: an access
// token of one of the factory's Linear installations, handed out by the hub.
// Reads the environment and the network, so it is only reached from a step, a
// check or the CLI — never from workflow code.

import type { FactoryContext } from "../config/factory-context.ts";
import type { HubTokens } from "./credentials.ts";
import type { ProviderAuth } from "./http.ts";
import { installationTokens } from "./installation-tokens.ts";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

/** The user Linear made for the factory's app in a workspace: who jigs is there. */
export interface LinearAppUser {
  id: string;
  name: string;
}

export interface LinearAuth extends ProviderAuth {
  /** The bearer token, asked of the hub again when less than `minLifetimeMs` of it is left. */
  bearer(minLifetimeMs?: number): Promise<string>;
  /** The app's own user in the workspace. */
  user(): Promise<LinearAppUser>;
}

type LinearTokens = Pick<
  HubTokens<{ token: string; app: { name: string; userId: string } }>,
  "issued" | "bearer" | "invalidate"
>;

export function createLinearAuth(tokens: LinearTokens): LinearAuth {
  return {
    bearer: tokens.bearer,
    invalidate: tokens.invalidate,
    async user() {
      const { app } = await tokens.issued();
      return { id: app.userId, name: app.name };
    },
  };
}

/** The credential for one Linear installation. */
export const linearAuthFor = (installationName: string, ctx?: FactoryContext): LinearAuth =>
  createLinearAuth(installationTokens("linear", installationName, ctx));
