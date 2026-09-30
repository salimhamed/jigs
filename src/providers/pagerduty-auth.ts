// The one credential source behind every PagerDuty call jigs makes: a scoped
// OAuth application's token, minted here with the client-credentials grant.
// Reads the environment and the network, so it is only reached from a step, a
// check, the service or the CLI — never from workflow code.

import {
  FACTORY_CONFIG_FILE,
  type PagerDutyIdentity,
  readFactoryConfig,
} from "../config/factory-config.ts";
import { factoryEnvValue } from "../config/factory-env.ts";
import { JigsError } from "../errors.ts";
import { credentialRoot } from "./credential-root.ts";

export const PAGERDUTY_TOKEN_URL = "https://identity.pagerduty.com/oauth/token";

// Every scope jigs asks for, beyond the account one. PagerDuty mints a token
// with only the scopes the app was granted, so a missing one surfaces as a 403
// on the first call that needs it, which is where the checks report it.
export const PAGERDUTY_SCOPES = [
  "incidents.read",
  "incidents.write",
  "webhook_subscriptions.read",
  "services.read",
  "users.read",
] as const;

/** The `.env` variables the PagerDuty identity needs. */
export const PAGERDUTY_IDENTITY_VARIABLES = [
  "PAGERDUTY_CLIENT_ID",
  "PAGERDUTY_CLIENT_SECRET",
] as const;

// A token lasts a day; one this close to its end is replaced before a call
// can carry it past expiry.
const EXPIRY_MARGIN_MS = 5 * 60_000;

export type EnvLookup = (name: string) => string | undefined;
type FetchLike = typeof fetch;

/** A PagerDuty credential from the factory's `.env`, or the shell outside a factory. */
export function pagerDutyEnvValue(name: string): string | undefined {
  try {
    return factoryEnvValue(credentialRoot(), name);
  } catch {
    const exported = process.env[name];
    return exported === "" ? undefined : exported;
  }
}

export function missingPagerDutyVariables(env: EnvLookup = pagerDutyEnvValue): string[] {
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
// description, with the secret cut out should either repeat it.
async function refusal(res: Response, secret: string): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    detail = [body.error, body.error_description]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(": ");
  } catch {
    // Not JSON: the status alone is what is safe to say.
  }
  return detail.replaceAll(secret, "[redacted]");
}

async function mintPagerDutyToken(
  identity: PagerDutyIdentity,
  clientId: string,
  clientSecret: string,
  doFetch: FetchLike,
  now: () => number,
): Promise<MintedToken> {
  const res = await doFetch(PAGERDUTY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: pagerDutyScope(identity),
    }).toString(),
  });
  if (!res.ok) {
    const detail = await refusal(res, clientSecret);
    throw new JigsError(
      `PagerDuty refused a client-credentials token (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
      `check PAGERDUTY_CLIENT_ID and PAGERDUTY_CLIENT_SECRET in the factory repo's .env against the PagerDuty scoped OAuth app, and that it grants ${PAGERDUTY_SCOPES.join(", ")} on ${identity.subdomain} (${identity.region}), then: \`pnpm exec jigs service restart\``,
    );
  }
  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new JigsError("PagerDuty's token response carried no access_token");
  }
  const lifetimeSeconds = typeof body.expires_in === "number" ? body.expires_in : 86400;
  return { token: body.access_token, expiresAt: now() + lifetimeSeconds * 1000 };
}

export interface PagerDutyAuth {
  identity: PagerDutyIdentity;
  /** The bearer token for a REST call, minted as needed. */
  bearer(): Promise<string>;
  /** Forget the minted token, so the next call mints a fresh one. */
  invalidate(): void;
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
  const env = deps.env ?? pagerDutyEnvValue;
  const now = deps.now ?? Date.now;
  const required = (name: string): string => {
    const value = env(name);
    if (value === undefined || value === "") {
      throw new JigsError(
        `${name} is not set, and the PagerDuty identity needs it`,
        `set ${name} in the factory repo's .env, then: \`pnpm exec jigs service restart\``,
      );
    }
    return value;
  };
  let cached: MintedToken | null = null;
  // The mint in flight, so concurrent calls share one token.
  let minting: Promise<MintedToken> | null = null;
  return {
    identity,
    async bearer(): Promise<string> {
      if (cached !== null && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;
      if (minting === null) {
        minting = mintPagerDutyToken(
          identity,
          required("PAGERDUTY_CLIENT_ID"),
          required("PAGERDUTY_CLIENT_SECRET"),
          deps.fetch ?? fetch,
          now,
        ).finally(() => {
          minting = null;
        });
      }
      cached = await minting;
      return cached.token;
    },
    invalidate(): void {
      cached = null;
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

/** Drop the cached credential so the next call re-reads configuration. */
export function resetPagerDutyAuth(): void {
  processAuth = null;
}
