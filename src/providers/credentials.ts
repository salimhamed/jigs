// Where every provider credential comes from: the factory context a call is
// made for.

import { currentFactoryContext, type FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";

// The service belongs to a factory repo, so its environment file is that
// repo's own .env and the restart is the CLI verb that supervises it.
export const SERVICE_ENV_FILE = "the factory repo's .env";
export const RESTART_SERVICE = "pnpm exec jigs service restart";

export type EnvLookup = (name: string) => string | undefined;

/** The credential's value, or a failure that says where to set it and what needs it. */
export function requireCredential(
  name: string,
  neededBy: string | undefined,
  env: EnvLookup,
): string {
  const value = env(name);
  if (value === undefined || value === "") {
    throw new JigsError(
      `${name} is not set${neededBy === undefined ? "" : `, and ${neededBy} needs it`}`,
      `set ${name} in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
    );
  }
  return value;
}

/**
 * One value per factory context, built on first use: a credential minted for one factory is never
 * handed to another, and a new context starts with nothing cached.
 */
export function perContext<T>(build: (ctx: FactoryContext) => T): (ctx?: FactoryContext) => T {
  const values = new WeakMap<FactoryContext, T>();
  return (ctx = currentFactoryContext()) => {
    if (!values.has(ctx)) values.set(ctx, build(ctx));
    return values.get(ctx) as T;
  };
}
