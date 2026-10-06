import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinearTokenResponse } from "@jigs-ai/hub-protocol";
import { and, eq } from "drizzle-orm";
import express, { type Request, type Router } from "express";
import { appOAuth } from "./app-oauth.ts";
import {
  type App,
  findApp,
  findNamedInstallation,
  type Installation,
  recordInstallation,
} from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, installations } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import { decryptJson, encryptJson } from "./secrets.ts";
import { parseWebhookJson, webhookBody } from "./webhooks.ts";

/** Where Linear sends one Linear app's webhooks. Linear's payloads do not name the app, so each has its own. */
export const linearWebhookPath = (appId: string) => `/webhooks/linear/${appId}`;

/** Where an admin starts connecting a Linear workspace to an app. */
export const linearConnectPath = (appId: string) => `/oauth/linear/${appId}/connect`;

/** Where Linear returns after a workspace admin approves an app, its "Callback URL". */
export const linearCallbackPath = (appId: string) => `/oauth/linear/${appId}/callback`;

/** The scopes every workspace grants: the factory reads and writes, and people mention and delegate to the app. */
export const linearScopes = "read,write,app:mentionable,app:assignable";

/** What the hub knows of a connected workspace besides its tokens, kept in `installations.settings`. */
export interface LinearWorkspaceSettings {
  name: string;
  /** The id of the user Linear made for the app in this workspace. */
  userId: string;
}

interface LinearAppSecrets {
  clientSecret: string;
  webhookSecret: string;
}

interface LinearWorkspaceSecrets {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/** What an admin copies from a Linear OAuth app they made by hand. */
export interface LinearAppInput extends LinearAppSecrets {
  name: string;
  clientId: string;
}

const defaultApiUrl = "https://api.linear.app";
const authorizeUrl = "https://linear.app/oauth/authorize";

/** Add a Linear app to an Organization, or say what is wrong with the input. */
export async function addLinearApp(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  input: LinearAppInput,
): Promise<{ app: App } | { error: string }> {
  if (!input.name || !input.clientId || !input.clientSecret || !input.webhookSecret) {
    return { error: "Enter the name, client ID, client secret and webhook signing secret." };
  }
  const [app] = await db
    .insert(apps)
    .values({
      organizationId,
      provider: "linear",
      name: input.name,
      externalId: input.clientId,
      settings: {},
      secrets: encryptJson<LinearAppSecrets>(encryptionKey, {
        clientSecret: input.clientSecret,
        webhookSecret: input.webhookSecret,
      }),
    })
    .onConflictDoNothing()
    .returning();
  if (!app)
    return { error: `The Linear app with client ID ${input.clientId} is already on this hub.` };
  return { app };
}

interface TokenBody {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const toSecrets = (body: TokenBody, now: number): LinearWorkspaceSecrets => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token,
  expiresAt: new Date(now + body.expires_in * 1000).toISOString(),
});

const requestToken = (apiUrl: string, form: Record<string, string>) =>
  fetch(`${apiUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

async function graphql<T>(
  apiUrl: string,
  token: string,
  query: string,
  variables?: object,
): Promise<T> {
  const response = await fetch(`${apiUrl}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!response.ok || body.errors?.length || !body.data) {
    const reason = body.errors?.map((error) => error.message).join("; ") ?? "";
    throw new Error(`Linear answered ${response.status} ${reason}`.trim());
  }
  return body.data;
}

const verifySignature = (secret: string, body: Buffer, header: string | undefined) => {
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(header ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

// Linear asks receivers to refuse a webhook sent more than a minute ago, against replays.
const MAX_WEBHOOK_AGE_MS = 60 * 1000;

/** Linear's webhooks and the OAuth flow that connects a Linear workspace to an app. */
export function createLinearRoutes(options: {
  db: HubDatabase;
  waiters: MessageWaiters;
  encryptionKey: Buffer;
  publicUrl: URL;
  linearTokens: LinearTokens;
  /** The Organization the request's signed-in user is an admin of, or `null`. */
  adminOrganization: (request: Request) => Promise<string | null>;
  /** Linear's API, replaced in tests. */
  apiUrl?: string;
}): Router {
  const { db, waiters, encryptionKey, publicUrl, linearTokens, adminOrganization } = options;
  const apiUrl = options.apiUrl ?? defaultApiUrl;
  const router = express.Router();

  const oauth = appOAuth({
    db,
    provider: "linear",
    label: "Linear",
    publicUrl,
    callbackPath: linearCallbackPath,
    adminOrganization,
  });

  router.post(linearWebhookPath(":appId"), webhookBody, async (request, response) => {
    const app = await findApp(db, "linear", String(request.params.appId));
    const body = request.body as Buffer;
    if (
      !app ||
      !verifySignature(
        decryptJson<LinearAppSecrets>(encryptionKey, app.secrets).webhookSecret,
        body,
        request.get("linear-signature"),
      )
    ) {
      response.status(401).json({ error: "The hub does not know this Linear app or signature." });
      return;
    }
    const payload = parseWebhookJson<{
      type?: string;
      action?: string;
      organizationId?: string;
      webhookTimestamp?: number;
      agentSession?: { id?: string };
    }>(body, response);
    if (!payload) return;
    if (
      typeof payload.webhookTimestamp !== "number" ||
      Math.abs(Date.now() - payload.webhookTimestamp) > MAX_WEBHOOK_AGE_MS
    ) {
      response.status(401).json({ error: "The webhook is more than a minute old." });
      return;
    }
    const name = payload.type ?? "";
    const installation = await db.query.installations.findFirst({
      where: and(
        eq(installations.appId, app.id),
        eq(installations.externalId, payload.organizationId ?? ""),
      ),
    });
    if (!installation) {
      console.warn(
        `[linear] dropped ${name} for ${app.name}: workspace ${payload.organizationId ?? "(none)"} is not connected to it`,
      );
      // 202, unlike Slack's 200: still a success, but the delivery log shows nothing was kept.
      response.status(202).end();
      return;
    }
    const { appendedTo } = await fanOutProviderEvent(db, waiters, {
      organizationId: app.organizationId,
      appId: app.id,
      installationId: installation.id,
      provider: "linear",
      name,
      payload,
    });
    const sessionId = payload.agentSession?.id;
    if (
      name === "AgentSessionEvent" &&
      payload.action === "created" &&
      sessionId &&
      appendedTo.length > 0
    ) {
      // Linear marks a session unresponsive unless an activity follows within ten
      // seconds, longer than a factory may take to hear of it.
      // https://linear.app/developers/agent-interaction
      void acknowledge(app, installation, sessionId);
    }
    response.status(200).end();
  });

  const acknowledge = async (app: App, installation: Installation, sessionId: string) => {
    try {
      const access = await linearTokens.access(app, installation);
      if ("failure" in access) throw new Error(access.failure);
      await graphql(
        apiUrl,
        access.token,
        `mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
        {
          input: {
            agentSessionId: sessionId,
            content: { type: "thought", body: "Received — working on it." },
          },
        },
      );
    } catch (error) {
      console.error(
        `[linear] could not acknowledge agent session ${sessionId} for ${app.name}: ${(error as Error).message}`,
      );
    }
  };

  router.get(linearConnectPath(":appId"), async (request, response) => {
    const app = await oauth.adminsApp(request, response);
    if (!app) return;
    const state = oauth.startState(response, app);
    const query = new URLSearchParams({
      client_id: app.externalId,
      redirect_uri: oauth.callbackUrl(app),
      response_type: "code",
      scope: linearScopes,
      state,
      actor: "app",
      prompt: "consent",
    });
    response.redirect(303, `${authorizeUrl}?${query}`);
  });

  router.get(linearCallbackPath(":appId"), async (request, response) => {
    const app = await oauth.adminsApp(request, response);
    if (!app || !oauth.checkCallback(request, response, app)) return;
    const { clientSecret } = decryptJson<LinearAppSecrets>(encryptionKey, app.secrets);
    const now = Date.now();
    const exchanged = await requestToken(apiUrl, {
      grant_type: "authorization_code",
      code: String(request.query.code ?? ""),
      redirect_uri: oauth.callbackUrl(app),
      client_id: app.externalId,
      client_secret: clientSecret,
    });
    if (!exchanged.ok) {
      response
        .status(502)
        .type("text")
        .send(`Linear refused the code (${exchanged.status}). Start again.`);
      return;
    }
    const secrets = toSecrets((await exchanged.json()) as TokenBody, now);
    const { viewer, organization } = await graphql<{
      viewer: { id: string };
      organization: { id: string; name: string; urlKey: string };
    }>(apiUrl, secrets.accessToken, "{ viewer { id } organization { id name urlKey } }");
    await recordInstallation(db, app, {
      externalId: organization.id,
      account: organization.urlKey,
      settings: { name: organization.name, userId: viewer.id } satisfies LinearWorkspaceSettings,
      secrets: encryptJson(encryptionKey, secrets),
    });
    response.redirect(303, `/apps/${app.id}`);
  });

  return router;
}

/** What {@link LinearTokens.issue} answers: a token, or the status and message to refuse with. */
export type LinearTokenResult =
  | { token: LinearTokenResponse }
  | { status: 404 | 503; error: string };

// A token is refreshed once it has less than this to live, so a factory can
// hand an agent one that outlasts a turn of several hours.
const MIN_TOKEN_LIFE_MS = 6 * 60 * 60 * 1000;

/**
 * Hands out the access tokens of connected Linear workspaces, refreshing them
 * with their refresh tokens as they near expiry.
 */
export class LinearTokens {
  // Linear's 30-minute grace period on a spent refresh token makes two
  // refreshes at once harmless; one at a time just saves a call.
  readonly #refreshing = new Map<
    string,
    Promise<{ token: string; expiresAt: string } | { failure: string }>
  >();
  readonly #db: HubDatabase;
  readonly #encryptionKey: Buffer;
  readonly #apiUrl: string;

  constructor(options: { db: HubDatabase; encryptionKey: Buffer; apiUrl?: string }) {
    this.#db = options.db;
    this.#encryptionKey = options.encryptionKey;
    this.#apiUrl = options.apiUrl ?? defaultApiUrl;
  }

  /** The token of the named workspace connected to a Linear app assigned to the factory. */
  async issue(
    factoryId: string,
    installationName: string,
    now = Date.now(),
  ): Promise<LinearTokenResult> {
    const found = await findNamedInstallation(this.#db, factoryId, "linear", installationName);
    if ("error" in found) return found;
    const { app, installation } = found;
    const access = await this.access(app, installation, now);
    if ("failure" in access) {
      return {
        status: 503,
        error: `Connect ${installation.account} to ${app.name} again on the hub: ${access.failure}`,
      };
    }
    const { userId } = installation.settings as LinearWorkspaceSettings;
    return { token: { ...access, app: { name: app.name, userId } } };
  }

  /** A workspace's access token, refreshed first if it is near expiry, or why there is none. */
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
    if (installation.secrets === null) return { failure: "The workspace has no tokens." };
    const secrets = decryptJson<LinearWorkspaceSecrets>(this.#encryptionKey, installation.secrets);
    return Date.parse(secrets.expiresAt) - now > MIN_TOKEN_LIFE_MS
      ? { token: secrets.accessToken, expiresAt: secrets.expiresAt }
      : null;
  }

  async #refresh(app: App, installationId: string, now: number) {
    // Re-read: a refresh that finished since the caller read the row left a fresh token.
    const installation = await this.#db.query.installations.findFirst({
      where: eq(installations.id, installationId),
    });
    if (!installation) return { failure: "The workspace is no longer connected." };
    const fresh = this.#fresh(installation, now);
    if (fresh) return fresh;
    const { refreshToken } = decryptJson<LinearWorkspaceSecrets>(
      this.#encryptionKey,
      installation.secrets ?? "",
    );
    const { clientSecret } = decryptJson<LinearAppSecrets>(this.#encryptionKey, app.secrets);
    // A reconnect while the refresh was out replaced these secrets; leave its row alone.
    const unchanged = and(
      eq(installations.id, installationId),
      eq(installations.secrets, installation.secrets ?? ""),
    );
    const response = await requestToken(this.#apiUrl, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: app.externalId,
      client_secret: clientSecret,
    });
    if (response.status === 400 || response.status === 401) {
      const failure = `Linear refused to refresh the token (${response.status}).`;
      await this.#db.update(installations).set({ failure }).where(unchanged);
      return { failure };
    }
    if (!response.ok) {
      throw new Error(
        `Linear answered ${response.status} refreshing ${app.name}'s token for ${installation.account}`,
      );
    }
    const secrets = toSecrets((await response.json()) as TokenBody, now);
    await this.#db
      .update(installations)
      .set({ secrets: encryptJson(this.#encryptionKey, secrets) })
      .where(unchanged);
    return { token: secrets.accessToken, expiresAt: secrets.expiresAt };
  }
}
