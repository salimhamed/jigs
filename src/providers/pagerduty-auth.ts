// The one credential source behind every PagerDuty call jigs makes: a scoped
// OAuth application's token, minted here with the client-credentials grant.
// Reads the environment and the network, so it is only reached from a step, a
// check, the service or the CLI — never from workflow code.

import {
  FACTORY_CONFIG_FILE,
  type PagerDutyIdentity,
  readFactoryConfig,
} from "../config/factory-config.ts";
import { JigsError } from "../errors.ts";
import {
  credentialRoot,
  credentialValue,
  type EnvLookup,
  onProviderReset,
  RESTART_SERVICE,
  requireCredential,
  SERVICE_ENV_FILE,
} from "./credentials.ts";
import { mintClientCredentials, type ProviderAuth } from "./http.ts";

export const PAGERDUTY_TOKEN_URL = "https://identity.pagerduty.com/oauth/token";

// Every scope jigs asks for, beyond the account one. PagerDuty mints a token
// with only the scopes the app was granted, so a missing one surfaces as a 403
// on the first call that needs it, which is where the checks report it.
export const PAGERDUTY_SCOPES = [
  "incidents.read",
  "incidents.write",
  "webhook_subscriptions.read",
  "users.read",
] as const;

/** The `.env` variables the PagerDuty identity needs. */
export const PAGERDUTY_IDENTITY_VARIABLES = [
  "PAGERDUTY_CLIENT_ID",
  "PAGERDUTY_CLIENT_SECRET",
] as const;

type FetchLike = typeof fetch;

export function missingPagerDutyVariables(env: EnvLookup = credentialValue): string[] {
  return PAGERDUTY_IDENTITY_VARIABLES.filter((name) => !env(name));
}

export function pagerDutyScope(identity: PagerDutyIdentity): string {
  return [`as_account-${identity.region}.${identity.subdomain}`, ...PAGERDUTY_SCOPES].join(" ");
}

interface MintedToken {
  token: string;
  expiresAt: number;
}

// The token endpoint's body is never quoted whole: only its error code and
// description.
function refusal(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    return [body.error, body.error_description]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(": ");
  } catch {
    return "";
  }
}

async function mintPagerDutyToken(
  identity: PagerDutyIdentity,
  clientId: string,
  clientSecret: string,
  doFetch: FetchLike | undefined,
  now: () => number,
): Promise<MintedToken> {
  const { accessToken, expiresIn } = await mintClientCredentials({
    provider: "pagerduty",
    url: PAGERDUTY_TOKEN_URL,
    clientId,
    clientSecret,
    scope: pagerDutyScope(identity),
    hint: `check PAGERDUTY_CLIENT_ID and PAGERDUTY_CLIENT_SECRET in ${SERVICE_ENV_FILE} against the PagerDuty scoped OAuth app, and that pagerduty.identity.subdomain and region name its account (now ${identity.subdomain}, ${identity.region}), then: \`${RESTART_SERVICE}\``,
    quote: refusal,
    fetch: doFetch,
  });
  const lifetimeSeconds = typeof expiresIn === "number" ? expiresIn : 86400;
  return { token: accessToken, expiresAt: now() + lifetimeSeconds * 1000 };
}

export interface PagerDutyAuth extends ProviderAuth {
  identity: PagerDutyIdentity;
  /** The bearer token for a REST call, minted as needed so it lives `minLifetimeMs` longer. */
  bearer(minLifetimeMs?: number): Promise<string>;
  /** Forget `stale` if it is still the cached token, so the next call mints a fresh one. */
  invalidate(stale: string): void;
}

export interface PagerDutyAuthDeps {
  fetch?: FetchLike;
  env?: EnvLookup;
  now?: () => number;
}

// Held in memory only, per process: there is no refresh token, and a new mint
// costs one request a day.
export function createPagerDutyAuth(
  identity: PagerDutyIdentity,
  deps: PagerDutyAuthDeps = {},
): PagerDutyAuth {
  const env = deps.env ?? credentialValue;
  const now = deps.now ?? Date.now;
  const required = (name: string): string => requireCredential(name, "the PagerDuty identity", env);
  let cached: MintedToken | null = null;
  let minting: Promise<MintedToken> | null = null;
  return {
    identity,
    async bearer(minLifetimeMs = 0): Promise<string> {
      if (cached !== null && cached.expiresAt > now() + minLifetimeMs) return cached.token;
      if (minting === null) {
        minting = mintPagerDutyToken(
          identity,
          required("PAGERDUTY_CLIENT_ID"),
          required("PAGERDUTY_CLIENT_SECRET"),
          deps.fetch,
          now,
        ).finally(() => {
          minting = null;
        });
      }
      cached = await minting;
      return cached.token;
    },
    // A late 401 on an old token must not discard one minted since.
    invalidate(stale: string): void {
      if (cached?.token === stale) cached = null;
    },
  };
}

/** The PagerDuty identity this factory is configured with. */
export function resolvePagerDutyIdentity(root?: string): PagerDutyIdentity {
  const pagerduty = readFactoryConfig(root ?? credentialRoot()).pagerduty;
  if (pagerduty === undefined) {
    throw new JigsError(
      `${FACTORY_CONFIG_FILE} has no pagerduty section`,
      `add pagerduty: { identity: { mode: "app", subdomain, region, from } } to ${FACTORY_CONFIG_FILE}, then: \`pnpm exec jigs up\``,
    );
  }
  return pagerduty.identity;
}

let processAuth: PagerDutyAuth | null = null;

/** This process's PagerDuty credential, cached once per process. */
export function pagerDutyAuthFor(): PagerDutyAuth {
  processAuth ??= createPagerDutyAuth(resolvePagerDutyIdentity());
  return processAuth;
}

onProviderReset(() => {
  processAuth = null;
});
