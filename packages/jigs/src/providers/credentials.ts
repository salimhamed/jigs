// Where every provider credential comes from: the factory context a call is
// made for.

import { currentFactoryContext, type FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";

// The service belongs to a factory repo, so its environment file is that
// repo's own .env and the restart is the CLI verb that supervises it.
export const SERVICE_ENV_FILE = "the factory repo's .env";
export const RESTART_SERVICE = "pnpm exec jigs up --restart-service";

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

// Ask the hub again while there is still time to fail and retry.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** How much life a token handed to an agent must have left: an agent's turn gets no refresh. */
export const AGENT_TOKEN_MIN_LIFETIME_MS = {
  // An installation token lives an hour, so the agent starts with close to all of it.
  github: 55 * 60 * 1000,
  // Under the six hours at which the hub refreshes, so asking again gets a new one.
  linear: 4 * 60 * 60 * 1000,
  // A PagerDuty token lasts about a day, and an agent's turn can last hours.
  pagerduty: 5 * 60 * 60 * 1000,
} as const;

/** Tokens the hub hands out, cached until shortly before they expire, or until refused when they never do. */
export interface HubTokens<T extends { token: string }> {
  /** The latest answer, asked of the hub again when less than `minLifetimeMs` of it is left. */
  issued(minLifetimeMs?: number): Promise<T>;
  bearer(minLifetimeMs?: number): Promise<string>;
  /** Forget `stale` if it is still the cached token, so the next call asks the hub again. */
  invalidate(stale: string): void;
}

/** A token without `expiresAt` never expires. */
export function createHubTokens<T extends { token: string; expiresAt?: string }>(
  issue: () => Promise<T>,
  now: () => number = Date.now,
): HubTokens<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  // The request in flight, not just the one that finished: a snapshot makes six
  // calls at once, and caching only the result would ask the hub six times.
  let issuing: Promise<{ value: T; expiresAt: number }> | null = null;
  const issued = async (minLifetimeMs = REFRESH_MARGIN_MS) => {
    if (cached !== null && cached.expiresAt - now() > minLifetimeMs) return cached.value;
    issuing ??= issue()
      .then((value) => ({
        value,
        expiresAt: value.expiresAt === undefined ? Infinity : Date.parse(value.expiresAt),
      }))
      .finally(() => {
        issuing = null;
      });
    cached = await issuing;
    return cached.value;
  };
  return {
    issued,
    bearer: async (minLifetimeMs) => (await issued(minLifetimeMs)).token,
    // A late rejection of an old token must not discard one issued since.
    invalidate(stale) {
      if (cached?.value.token === stale) cached = null;
    },
  };
}
