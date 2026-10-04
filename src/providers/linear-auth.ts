// The one credential source behind every Linear call jigs makes. Two modes: a
// personal API key, or an OAuth application token minted here with the
// client-credentials grant. Reads the environment and the network, so it is
// only reached from a step, a check or the CLI — never from workflow code.

import { type LinearIdentity, readFactoryConfig } from "../config/factory-config.ts";
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
import type { ProviderAuth } from "./http.ts";

export const LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

// Minting with a different scope set revokes every live token for the app, so
// a running factory hits one 401 after a release that changes this.
const APP_SCOPE = "read,write";

/** The `.env` variables each Linear identity mode needs. */
export const LINEAR_IDENTITY_VARIABLES = {
  key: ["LINEAR_API_KEY"],
  app: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
} as const satisfies Record<LinearIdentity["mode"], readonly string[]>;

type FetchLike = typeof fetch;

/** The variables the identity needs that are unset. */
export function missingLinearVariables(
  identity: LinearIdentity,
  env: EnvLookup = credentialValue,
): string[] {
  return LINEAR_IDENTITY_VARIABLES[identity.mode].filter((name) => !env(name));
}

async function mintLinearAppToken(
  clientId: string,
  clientSecret: string,
  doFetch: FetchLike,
): Promise<string> {
  const res = await doFetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: APP_SCOPE,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new JigsError(
      `Linear refused a client-credentials token (HTTP ${res.status}): ${text.replaceAll(clientSecret, "[redacted]")}`,
      `check LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in ${SERVICE_ENV_FILE} against the Linear OAuth application, and that client credentials are enabled on it, then: \`${RESTART_SERVICE}\``,
    );
  }
  let body: { access_token?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new JigsError(`Linear's token response (HTTP ${res.status}) was not JSON`);
  }
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new JigsError("Linear's token response carried no access_token");
  }
  return body.access_token;
}

export interface LinearAuth extends ProviderAuth {
  identity: LinearIdentity;
  /** The bare credential: the API key, or the app's token, minted as needed. */
  bearer(): Promise<string>;
  /** App mode only: forget `stale` if it is still the cached token, so the next call mints afresh. */
  invalidate?(stale: string): void;
}

export interface LinearAuthDeps {
  fetch?: FetchLike;
  env?: EnvLookup;
}

export function createLinearAuth(identity: LinearIdentity, deps: LinearAuthDeps = {}): LinearAuth {
  const env = deps.env ?? credentialValue;
  const required = (name: string): string =>
    requireCredential(name, `linear.identity mode "${identity.mode}"`, env);
  if (identity.mode === "key") {
    return { identity, bearer: async () => required("LINEAR_API_KEY") };
  }
  // The token Linear issues lasts 30 days; its expires_in is not trusted, and
  // a rejection is what retires it.
  let cached: string | null = null;
  let minting: Promise<string> | null = null;
  return {
    identity,
    async bearer(): Promise<string> {
      if (cached !== null) return cached;
      if (minting === null) {
        minting = mintLinearAppToken(
          required("LINEAR_CLIENT_ID"),
          required("LINEAR_CLIENT_SECRET"),
          deps.fetch ?? fetch,
        ).finally(() => {
          minting = null;
        });
      }
      cached = await minting;
      return cached;
    },
    // A late rejection of an old token must not discard one minted since.
    invalidate(stale: string): void {
      if (cached === stale) cached = null;
    },
  };
}

/**
 * The Linear identity this factory is configured with. Outside a factory there
 * is no config to read and a personal key is the only credential there is.
 */
export function resolveLinearIdentity(root?: string): LinearIdentity {
  let dir: string;
  try {
    dir = root ?? credentialRoot();
  } catch {
    return { mode: "key" };
  }
  return readFactoryConfig(dir).linear.identity;
}

let processAuth: LinearAuth | null = null;

/** This process's Linear credential, cached once per process. */
export function linearAuthFor(): LinearAuth {
  processAuth ??= createLinearAuth(resolveLinearIdentity());
  return processAuth;
}

onProviderReset(() => {
  processAuth = null;
});
