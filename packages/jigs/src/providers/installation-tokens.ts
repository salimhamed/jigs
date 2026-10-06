// The factory's token cache: one per provider and installation name, per
// factory context, each asked of the hub through `hubToken`.

import type { Provider } from "@jigs-ai/hub-protocol";
import type { FactoryContext } from "../config/factory-context.ts";
import { createHubTokens, type HubTokens, perContext } from "./credentials.ts";
import { type HubTokenResponses, hubToken } from "./hub.ts";

const factoryTokens = perContext((ctx) => ({
  ctx,
  tokens: new Map<string, HubTokens<HubTokenResponses[Provider]>>(),
}));

/** The factory's cached tokens for one installation, asked of the hub once per factory context. */
export function installationTokens<P extends Provider>(
  provider: P,
  installationName: string,
  ctx?: FactoryContext,
): HubTokens<HubTokenResponses[P]> {
  const factory = factoryTokens(ctx);
  const key = `${provider}:${installationName}`;
  let tokens = factory.tokens.get(key);
  if (!tokens) {
    tokens = createHubTokens(() => hubToken(provider, installationName, factory.ctx));
    factory.tokens.set(key, tokens);
  }
  return tokens as HubTokens<HubTokenResponses[P]>;
}
