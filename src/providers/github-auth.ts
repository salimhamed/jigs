// The one credential source behind every GitHub call jigs makes. Two modes:
// the operator's personal access token, or a GitHub App installation token
// minted here from the App's private key. Reads the environment and the
// filesystem, so it is only reached from a step, a check or the CLI — never
// workflow-side.

import { createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  type AppIdentity,
  type GithubIdentity,
  readFactoryConfig,
} from "../config/factory-config.ts";
import { factoryEnvValue } from "../config/factory-env.ts";
import { factoryRoot } from "../config/factory-root.ts";
import { JigsError } from "../errors.ts";

export const GITHUB_API_BASE = (): string => process.env.GITHUB_API_URL ?? "https://api.github.com";

/** An installation token lives an hour; renew it while there is still time to fail and retry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// GitHub rejects a JWT whose `iat` is ahead of its own clock, so the backdate
// absorbs the operator's drift, and nine minutes keeps it inside the ten the
// API accepts.
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;

export interface AppInstallation {
  permissions: Record<string, string>;
}

export interface AppRegistration {
  slug: string;
  name: string;
}

const base64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/** Sign the App's own credential: the claim GitHub exchanges for an installation token. */
export function mintAppJwt(appId: number, privateKey: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: issuedAt - JWT_BACKDATE_SECONDS,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
      iss: appId,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey, "base64url")}`;
}

export interface PrivateKeyFile {
  key: string;
  /** Set when the file is readable by more than its owner. */
  looseMode?: string;
}

export function readAppPrivateKey(file: string): PrivateKeyFile {
  let key: string;
  try {
    key = readFileSync(file, "utf8");
  } catch (error) {
    throw new JigsError(
      `cannot read the GitHub App private key at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      `download the App's private key and point github.identity.privateKeyPath at it, then: chmod 600 ${file}`,
    );
  }
  if (!key.includes("PRIVATE KEY")) {
    throw new JigsError(
      `${file} is not a PEM private key`,
      "use the .pem file GitHub generates under the App's “Private keys” section",
    );
  }
  const mode = statSync(file).mode & 0o777;
  return (mode & 0o077) === 0
    ? { key }
    : { key, looseMode: `0${mode.toString(8).padStart(3, "0")}` };
}

interface MintedToken {
  token: string;
  expiresAt: number;
}

export type FetchLike = typeof fetch;

/** Exchange the App JWT for a token scoped to one installation. */
export async function mintInstallationToken(
  identity: AppIdentity,
  privateKey: string,
  deps: { now?: () => number; fetch?: FetchLike } = {},
): Promise<MintedToken> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const jwt = mintAppJwt(identity.appId, privateKey, now());
  const res = await doFetch(
    `${GITHUB_API_BASE()}/app/installations/${identity.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new JigsError(
      `GitHub refused an installation token for App ${identity.appId} installation ${identity.installationId} (HTTP ${res.status})`,
      "check github.identity.appId, installationId and privateKeyPath, and that the App is still installed — jigs doctor names which one is wrong",
    );
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/** Read the installation's granted permissions, for doctor. */
export async function fetchAppInstallation(
  identity: AppIdentity,
  privateKey: string,
  deps: { now?: () => number; fetch?: FetchLike } = {},
): Promise<AppInstallation> {
  return appJwtGet<AppInstallation>(
    `/app/installations/${identity.installationId}`,
    identity,
    privateKey,
    deps,
  );
}

/** Read the App registration, whose slug is the `<slug>[bot]` login jigs posts as. */
export async function fetchAppRegistration(
  identity: AppIdentity,
  privateKey: string,
  deps: { now?: () => number; fetch?: FetchLike } = {},
): Promise<AppRegistration> {
  return appJwtGet<AppRegistration>("/app", identity, privateKey, deps);
}

async function appJwtGet<T>(
  apiPath: string,
  identity: AppIdentity,
  privateKey: string,
  deps: { now?: () => number; fetch?: FetchLike },
): Promise<T> {
  const doFetch = deps.fetch ?? fetch;
  const jwt = mintAppJwt(identity.appId, privateKey, (deps.now ?? Date.now)());
  const res = await doFetch(`${GITHUB_API_BASE()}${apiPath}`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new JigsError(`GitHub API ${res.status} on ${apiPath}`);
  }
  return (await res.json()) as T;
}

export interface GithubAuth {
  identity: GithubIdentity;
  /** The bearer token for a REST or GraphQL call, minted or renewed as needed. */
  bearer(): Promise<string>;
}

export interface GithubAuthDeps {
  now?: () => number;
  fetch?: FetchLike;
  readPrivateKey?: (file: string) => PrivateKeyFile;
  patToken?: () => string | undefined;
}

export function createGithubAuth(identity: GithubIdentity, deps: GithubAuthDeps = {}): GithubAuth {
  const now = deps.now ?? Date.now;
  const mint = async (): Promise<MintedToken> => {
    if (identity.mode !== "app") throw new Error("only an App identity mints tokens");
    const { key } = (deps.readPrivateKey ?? readAppPrivateKey)(identity.privateKeyPath);
    return mintInstallationToken(identity, key, deps);
  };
  let cached: MintedToken | null = null;
  // The mint in flight, not just the one that finished: a snapshot makes six
  // calls at once, and caching only the result would mint six tokens.
  let minting: Promise<MintedToken> | null = null;
  return {
    identity,
    async bearer(): Promise<string> {
      if (identity.mode === "pat") {
        const token = (deps.patToken ?? environmentPat)();
        if (token === undefined || token === "") {
          throw new JigsError(
            "GITHUB_TOKEN is not set",
            "set GITHUB_TOKEN in the factory repo's .env, then: jigs service restart",
          );
        }
        return token;
      }
      if (cached !== null && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.token;
      if (minting === null) {
        minting = mint().finally(() => {
          minting = null;
        });
      }
      const pending = minting;
      cached = await pending;
      return cached.token;
    },
  };
}

function environmentPat(): string | undefined {
  try {
    return factoryEnvValue(currentFactoryRoot(), "GITHUB_TOKEN");
  } catch {
    // Outside a factory the shell is the only environment there is.
    return process.env.GITHUB_TOKEN;
  }
}

// The service answers for the factory it was started with; a CLI verb locates
// one from the directory the operator typed it in, which is not necessarily
// the process's own. Naming it is how the credential follows.
let factoryRootOverride: string | null = null;

export function useFactoryRoot(root: string): void {
  factoryRootOverride = root;
  processAuth = null;
}

const currentFactoryRoot = (): string => factoryRootOverride ?? factoryRoot();

/**
 * The identity this factory is configured with, with the private key path
 * resolved against the factory root. Outside a factory there is no config to
 * read and the personal token is the only credential there is.
 */
export function resolveGithubIdentity(root?: string): GithubIdentity {
  let dir: string;
  try {
    dir = root ?? currentFactoryRoot();
  } catch {
    return { mode: "pat" };
  }
  const identity = readFactoryConfig(dir).github.identity;
  if (identity.mode === "pat") return identity;
  return { ...identity, privateKeyPath: path.resolve(dir, identity.privateKeyPath) };
}

// One auth per process: renewing the installation token is the point of
// holding it, and a changed identity needs a service restart anyway, because
// the token in flight was minted for the old one.
let processAuth: GithubAuth | null = null;

export function githubAuth(): GithubAuth {
  processAuth ??= createGithubAuth(resolveGithubIdentity());
  return processAuth;
}

/** Drop the process-wide auth, so the next call re-reads the configuration. */
export function resetGithubAuth(): void {
  processAuth = null;
  factoryRootOverride = null;
}
