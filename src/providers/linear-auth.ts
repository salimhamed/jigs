// The one credential source behind every Linear call jigs makes. Two modes: a
// personal API key, or an OAuth application token minted here with the
// client-credentials grant. Reads the environment and the network, so it is
// only reached from a step, a check or the CLI — never from workflow code.

import { type LinearIdentity, readFactoryConfig } from "../config/factory-config.ts";
import { factoryEnvValue } from "../config/factory-env.ts";
import { JigsError } from "../errors.ts";
import { credentialRoot, setCredentialRoot } from "./credential-root.ts";

// A test seam, and the origin the OAuth token endpoint is derived from.
export const LINEAR_API_URL = (): string =>
  process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";

// Minting with a different scope set revokes every live token for the app, so
// a running factory hits one 401 after a release that changes this.
const APP_SCOPE = "read,write";

/** The `.env` variables each Linear identity mode needs. */
export const LINEAR_IDENTITY_VARIABLES = {
  key: ["LINEAR_API_KEY"],
  app: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
} as const satisfies Record<LinearIdentity["mode"], readonly string[]>;

export type EnvLookup = (name: string) => string | undefined;

type FetchLike = typeof fetch;

/** A Linear credential from the factory's `.env`, or the shell outside a factory. */
export function linearEnvValue(name: string): string | undefined {
  try {
    return factoryEnvValue(credentialRoot(), name);
  } catch {
    const exported = process.env[name];
    return exported === "" ? undefined : exported;
  }
}

/** The variables the identity needs that are unset. */
export function missingLinearVariables(
  identity: LinearIdentity,
  env: EnvLookup = linearEnvValue,
): string[] {
  return LINEAR_IDENTITY_VARIABLES[identity.mode].filter((name) => !env(name));
}

/** Exchange an OAuth application's client id and secret for a token that acts as the app. */
export async function mintLinearAppToken(
  clientId: string,
  clientSecret: string,
  doFetch: FetchLike = fetch,
): Promise<string> {
  const res = await doFetch(`${new URL(LINEAR_API_URL()).origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: APP_SCOPE,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    throw new JigsError(
      `Linear refused a client-credentials token (HTTP ${res.status}): ${await res.text()}`,
      "check LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in the factory repo's .env against the Linear OAuth application, and that client credentials are enabled on it, then: pnpm exec jigs service restart",
    );
  }
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new JigsError("Linear's token response carried no access_token");
  }
  return body.access_token;
}

export interface LinearAuth {
  identity: LinearIdentity;
  /** The `authorization` header value for a GraphQL call, minted as needed. */
  authorization(): Promise<string>;
  /** Forget a minted token, so the next call mints a fresh one. */
  invalidate(): void;
}

export interface LinearAuthDeps {
  fetch?: FetchLike;
  env?: EnvLookup;
}

export function createLinearAuth(identity: LinearIdentity, deps: LinearAuthDeps = {}): LinearAuth {
  const env = deps.env ?? linearEnvValue;
  const required = (name: string): string => {
    const value = env(name);
    if (value === undefined || value === "") {
      throw new JigsError(
        `${name} is not set, and linear.identity mode "${identity.mode}" needs it`,
        `set ${name} in the factory repo's .env, then: pnpm exec jigs service restart`,
      );
    }
    return value;
  };
  // The token Linear issues lasts 30 days; its expires_in is not trusted, and
  // a 401 is what retires it.
  let cached: string | null = null;
  // The mint in flight, so concurrent calls share one token.
  let minting: Promise<string> | null = null;
  return {
    identity,
    async authorization(): Promise<string> {
      if (identity.mode === "key") return required("LINEAR_API_KEY");
      if (cached !== null) return `Bearer ${cached}`;
      if (minting === null) {
        minting = mintLinearAppToken(
          required("LINEAR_CLIENT_ID"),
          required("LINEAR_CLIENT_SECRET"),
          deps.fetch,
        ).finally(() => {
          minting = null;
        });
      }
      const pending = minting;
      cached = await pending;
      return `Bearer ${cached}`;
    },
    invalidate(): void {
      cached = null;
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

const processAuth = new Map<LinearIdentity["mode"], LinearAuth>();
let processIdentity: LinearIdentity | null = null;

/** This process's Linear credential, cached once per process. */
export function linearAuthFor(): LinearAuth {
  processIdentity ??= resolveLinearIdentity();
  let auth = processAuth.get(processIdentity.mode);
  if (!auth) {
    auth = createLinearAuth(processIdentity);
    processAuth.set(processIdentity.mode, auth);
  }
  return auth;
}

/** Drop cached credentials so the next call re-reads configuration. */
export function resetLinearAuth(): void {
  processAuth.clear();
  processIdentity = null;
  setCredentialRoot(null);
}
