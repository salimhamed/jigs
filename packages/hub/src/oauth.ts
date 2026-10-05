import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import type { App } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { installations } from "./db/schema.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

export type Installation = typeof installations.$inferSelect;

/** An installation's OAuth tokens, kept encrypted in `installations.secrets`. */
export interface OAuthSecrets {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/** The fields of a provider's OAuth token response the hub keeps. */
export interface TokenBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export const toOAuthSecrets = (body: TokenBody, now: number): OAuthSecrets => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token,
  expiresAt: new Date(now + body.expires_in * 1000).toISOString(),
});

export const postForm = (url: string, form: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

export const readSecrets = <T>(encryptionKey: Buffer, stored: string): T =>
  JSON.parse(decryptSecret(encryptionKey, stored));

export const readCookie = (request: Request, name: string) => {
  for (const part of (request.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
};

// A token is refreshed once it has less than this to live.
const MIN_TOKEN_LIFE_MS = 5 * 60 * 1000;

/**
 * Hands out installations' OAuth access tokens, refreshing them with their
 * refresh tokens as they near expiry. A refused refresh marks the
 * installation as needing a reconnect.
 */
export class RefreshingTokens {
  // Providers rotate the refresh token, so one refresh at a time per installation.
  readonly #refreshing = new Map<
    string,
    Promise<{ token: string; expiresAt: string } | { failure: string }>
  >();
  readonly #db: HubDatabase;
  readonly #encryptionKey: Buffer;
  readonly #provider: string;
  readonly #tokenUrl: string;

  constructor(options: {
    db: HubDatabase;
    encryptionKey: Buffer;
    /** The provider's name, for messages. */
    provider: string;
    tokenUrl: string;
  }) {
    this.#db = options.db;
    this.#encryptionKey = options.encryptionKey;
    this.#provider = options.provider;
    this.#tokenUrl = options.tokenUrl;
  }

  /** An installation's access token, refreshed first if it is near expiry, or why there is none. */
  async access(
    app: App,
    installation: Installation,
    now = Date.now(),
  ): Promise<{ token: string; expiresAt: string } | { failure: string }> {
    const fresh = this.#fresh(installation, now);
    if (fresh) return fresh;
    let refreshing = this.#refreshing.get(installation.id);
    if (!refreshing) {
      refreshing = this.#refresh(app, installation.id, now).finally(() =>
        this.#refreshing.delete(installation.id),
      );
      this.#refreshing.set(installation.id, refreshing);
    }
    return refreshing;
  }

  #fresh(installation: Installation, now: number) {
    if (installation.failure !== null) return { failure: installation.failure };
    if (installation.secrets === null) return { failure: "The installation has no tokens." };
    const secrets = readSecrets<OAuthSecrets>(this.#encryptionKey, installation.secrets);
    return Date.parse(secrets.expiresAt) - now > MIN_TOKEN_LIFE_MS
      ? { token: secrets.accessToken, expiresAt: secrets.expiresAt }
      : null;
  }

  async #refresh(app: App, installationId: string, now: number) {
    // Re-read: a refresh that finished since the caller read the row left a fresh token.
    const installation = await this.#db.query.installations.findFirst({
      where: eq(installations.id, installationId),
    });
    if (!installation) return { failure: "The installation is no longer connected." };
    const fresh = this.#fresh(installation, now);
    if (fresh) return fresh;
    const { refreshToken } = readSecrets<OAuthSecrets>(
      this.#encryptionKey,
      installation.secrets ?? "",
    );
    const { clientSecret } = readSecrets<{ clientSecret: string }>(
      this.#encryptionKey,
      app.secrets,
    );
    // A reconnect while the refresh was out replaced these secrets; leave its row alone.
    const unchanged = and(
      eq(installations.id, installationId),
      eq(installations.secrets, installation.secrets ?? ""),
    );
    const response = await postForm(this.#tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: app.externalId,
      client_secret: clientSecret,
    });
    if (response.status === 400 || response.status === 401) {
      const failure = `${this.#provider} refused to refresh the token (${response.status}).`;
      await this.#db.update(installations).set({ failure }).where(unchanged);
      return { failure };
    }
    if (!response.ok) {
      throw new Error(
        `${this.#provider} answered ${response.status} refreshing ${app.name}'s token for ${installation.account}`,
      );
    }
    const secrets = toOAuthSecrets((await response.json()) as TokenBody, now);
    await this.#db
      .update(installations)
      .set({ secrets: encryptSecret(this.#encryptionKey, JSON.stringify(secrets)) })
      .where(unchanged);
    return { token: secrets.accessToken, expiresAt: secrets.expiresAt };
  }
}
