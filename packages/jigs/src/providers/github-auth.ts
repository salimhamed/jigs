// The one credential source behind every GitHub call jigs makes. Two modes:
// the operator's personal access token, or a GitHub App installation token
// minted here from the App's private key. Reads the environment and the
// filesystem, so it is only reached from a step, a check or the CLI — never
// from workflow code.

import { createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import {
  type AppIdentity,
  type GithubIdentity,
  installationFor,
  type ResolvedAppIdentity,
  type ResolvedGithubIdentity,
} from "../workflow/factory-schema.ts";
import { type EnvLookup, perContext, requireCredential } from "./credentials.ts";
import { githubSend } from "./github-http.ts";
import type { ProviderAuth } from "./http.ts";

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
      `download the App's private key and set privateKeyPath in the configured App entry to that file, then: \`chmod 600 ${file}\``,
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

// The App's own credential, signed afresh for each attempt.
const appJwtAuth = (
  identity: Pick<AppIdentity, "appId">,
  privateKey: string,
  now: () => number,
): ProviderAuth => ({ bearer: async () => mintAppJwt(identity.appId, privateKey, now()) });

/** Exchange the App JWT for a token scoped to one installation. */
export async function mintInstallationToken(
  identity: ResolvedAppIdentity,
  privateKey: string,
  deps: { now?: () => number } = {},
): Promise<MintedToken> {
  const body = await githubSend<{ token: string; expires_at: string }>({
    auth: appJwtAuth(identity, privateKey, deps.now ?? Date.now),
    method: "POST",
    apiPath: `/app/installations/${identity.installationId}/access_tokens`,
    outlivesRun: true,
    refuse: (res) =>
      new JigsError(
        `GitHub refused an installation token for App ${identity.appId} installation ${identity.installationId} (HTTP ${res.status})`,
        `check App ${identity.appId}’s entry in jigs.config.ts: appId, installations and privateKeyPath, and that installation ${identity.installationId} still exists\nfind which one is wrong: \`pnpm exec jigs doctor\``,
      ),
  });
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/** Read the installation's granted permissions, for doctor. */
export function fetchAppInstallation(
  identity: ResolvedAppIdentity,
  privateKey: string,
  deps: { now?: () => number } = {},
): Promise<AppInstallation> {
  return githubSend<AppInstallation>({
    auth: appJwtAuth(identity, privateKey, deps.now ?? Date.now),
    apiPath: `/app/installations/${identity.installationId}`,
  });
}

/** Read the App registration, whose slug is the `<slug>[bot]` login jigs posts as. */
export function fetchAppRegistration(
  identity: Pick<AppIdentity, "appId">,
  privateKey: string,
  deps: { now?: () => number } = {},
): Promise<AppRegistration> {
  return githubSend<AppRegistration>({
    auth: appJwtAuth(identity, privateKey, deps.now ?? Date.now),
    apiPath: "/app",
  });
}

export interface GithubAuth extends ProviderAuth {
  identity: ResolvedGithubIdentity;
  /**
   * The bearer token for a REST or GraphQL call, minted or renewed as needed. An App token is
   * renewed when less than `minLifetimeMs` of it is left.
   */
  bearer(minLifetimeMs?: number): Promise<string>;
}

export interface GithubAuthDeps {
  now?: () => number;
  readPrivateKey?: (file: string) => PrivateKeyFile;
  env: EnvLookup;
}

export function createGithubAuth(
  identity: ResolvedGithubIdentity,
  deps: GithubAuthDeps,
): GithubAuth {
  if (identity.mode === "pat") {
    const env = deps.env;
    return {
      identity,
      bearer: async () => requireCredential("GITHUB_TOKEN", "the GitHub identity", env),
    };
  }
  const now = deps.now ?? Date.now;
  const mint = async (): Promise<MintedToken> => {
    const { key } = (deps.readPrivateKey ?? readAppPrivateKey)(identity.privateKeyPath);
    return mintInstallationToken(identity, key, deps);
  };
  let cached: MintedToken | null = null;
  // The mint in flight, not just the one that finished: a snapshot makes six
  // calls at once, and caching only the result would mint six tokens.
  let minting: Promise<MintedToken> | null = null;
  return {
    identity,
    async bearer(minLifetimeMs = REFRESH_MARGIN_MS): Promise<string> {
      if (cached !== null && cached.expiresAt - now() > minLifetimeMs) return cached.token;
      if (minting === null) {
        minting = mint().finally(() => {
          minting = null;
        });
      }
      const pending = minting;
      cached = await pending;
      return cached.token;
    },
    // A late 401 on an old token must not discard one minted since.
    invalidate(stale: string): void {
      if (cached?.token === stale) cached = null;
    },
  };
}

interface FactoryGithub {
  identities: GithubIdentity[];
  auths: Map<string, GithubAuth>;
  env: EnvLookup;
}

// The configured identities with each private key path resolved against the
// factory root, and the credentials minted from them, kept per factory.
const factoryGithub = perContext(
  (ctx): FactoryGithub => ({
    identities: ctx.config.github.identities.map((identity) =>
      identity.mode === "pat"
        ? identity
        : { ...identity, privateKeyPath: path.resolve(ctx.root, identity.privateKeyPath) },
    ),
    auths: new Map(),
    env: ctx.env,
  }),
);

/** The factory's GitHub identities, with each private key path resolved against its root. */
export function githubIdentities(ctx?: FactoryContext): GithubIdentity[] {
  return factoryGithub(ctx).identities;
}

/** Whether this factory acts through a personal access token, which is then its only identity. */
export function githubUsesPat(ctx?: FactoryContext): boolean {
  return githubIdentities(ctx).some((identity) => identity.mode === "pat");
}

/** The credential for one account, created once per factory. Its `identity` is who jigs acts as there. */
export function githubAuthFor(account: string, ctx?: FactoryContext): GithubAuth {
  const github = factoryGithub(ctx);
  const identity = installationFor(github.identities, account);
  const key = identity.mode === "pat" ? "pat" : `${identity.appId}:${identity.installationId}`;
  let auth = github.auths.get(key);
  if (!auth) {
    auth = createGithubAuth(identity, { env: github.env });
    github.auths.set(key, auth);
  }
  return auth;
}

/** The account a GitHub App acts as: `<slug>[bot]`, with that account's user id. */
export interface AppBot {
  login: string;
  id: number;
}

const appBots = new Map<number, Promise<AppBot>>();

/** The App's bot account, looked up once per App. */
export function appBotFor(
  identity: ResolvedAppIdentity,
  bearer: () => Promise<string>,
  deps: Pick<GithubAuthDeps, "readPrivateKey"> = {},
): Promise<AppBot> {
  let bot = appBots.get(identity.appId);
  if (bot === undefined) {
    bot = lookupAppBot(identity, bearer, deps);
    appBots.set(identity.appId, bot);
    bot.catch(() => appBots.delete(identity.appId));
  }
  return bot;
}

async function lookupAppBot(
  identity: ResolvedAppIdentity,
  bearer: () => Promise<string>,
  deps: Pick<GithubAuthDeps, "readPrivateKey">,
): Promise<AppBot> {
  const { key } = (deps.readPrivateKey ?? readAppPrivateKey)(identity.privateKeyPath);
  const { slug } = await fetchAppRegistration(identity, key);
  const login = `${slug}[bot]`;
  const { id } = await githubSend<{ id: number }>({
    auth: { bearer },
    apiPath: `/users/${encodeURIComponent(login)}`,
  });
  return { login, id };
}
