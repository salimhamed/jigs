import { createHmac, timingSafeEqual } from "node:crypto";
import { type SlackTokenResponse, slackBotScopes } from "@jigs-ai/hub-protocol";
import { and, eq, sql } from "drizzle-orm";
import express, { type Request, type Router } from "express";
import { appOAuth } from "./app-oauth.ts";
import { type App, findNamedInstallation, recordInstallation } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, installations } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import { decryptJson, encryptJson } from "./secrets.ts";
import { parseWebhookJson, webhookBody } from "./webhooks.ts";

/** Where Slack sends every Slack app's events, its Event Subscriptions "Request URL". */
export const slackWebhookPath = "/webhooks/slack";

/** Where an admin starts installing a Slack app to a workspace. */
export const slackInstallPath = (appId: string) => `/oauth/slack/${appId}/install`;

/** Where Slack returns after a workspace approves an app, its OAuth "Redirect URL". */
export const slackCallbackPath = (appId: string) => `/oauth/slack/${appId}/callback`;

/** The bot events factories hear. */
export const slackBotEvents = ["message.channels", "message.groups"] as const;

/** What the hub knows of a Slack app besides its secrets, kept in `apps.settings`. Its Slack app ID is its `externalId`. */
export interface SlackAppSettings {
  clientId: string;
  /** The bot token scopes an install asks for. */
  scopes: string[];
}

/** What the hub knows of a workspace an app is installed in, kept in `installations.settings`. */
export interface SlackWorkspaceSettings {
  botUserId: string;
  /** The bot token scopes the workspace granted. */
  scopes: string[];
}

interface SlackAppSecrets {
  clientSecret: string;
  signingSecret: string;
}

interface SlackWorkspaceSecrets {
  botToken: string;
}

/** What an admin copies from a Slack app they made by hand. */
export interface SlackAppInput extends SlackAppSecrets {
  name: string;
  appId: string;
  clientId: string;
}

const defaultApiUrl = "https://slack.com/api";
const authorizeUrl = "https://slack.com/oauth/v2/authorize";

/** Add a Slack app to an Organization, or say what is wrong with the input. */
export async function addSlackApp(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  input: SlackAppInput,
): Promise<{ app: App } | { error: string }> {
  if (
    !input.name ||
    !input.appId ||
    !input.clientId ||
    !input.clientSecret ||
    !input.signingSecret
  ) {
    return { error: "Enter the name, app ID, client ID, client secret and signing secret." };
  }
  const [app] = await db
    .insert(apps)
    .values({
      organizationId,
      provider: "slack",
      name: input.name,
      externalId: input.appId,
      settings: {
        clientId: input.clientId,
        scopes: [...slackBotScopes],
      } satisfies SlackAppSettings,
      secrets: encryptJson<SlackAppSecrets>(encryptionKey, {
        clientSecret: input.clientSecret,
        signingSecret: input.signingSecret,
      }),
    })
    .onConflictDoNothing()
    .returning();
  if (!app) return { error: `The Slack app ${input.appId} is already on this hub.` };
  return { app };
}

const SCOPE = /^[a-z][a-z_.:-]*$/;

/**
 * Set the bot token scopes an app's installs ask for, from a list split on
 * commas or spaces. The list keeps every scope in `slackBotScopes`.
 */
export async function setSlackScopes(
  db: HubDatabase,
  organizationId: string,
  appId: string,
  list: string,
): Promise<{ error: string } | { scopes: string[] }> {
  const scopes = [...new Set(list.split(/[\s,]+/).filter(Boolean))];
  const bad = scopes.filter((scope) => !SCOPE.test(scope));
  if (bad.length > 0) return { error: `These are not Slack scopes: ${bad.join(", ")}.` };
  const dropped = slackBotScopes.filter((scope) => !scopes.includes(scope));
  if (dropped.length > 0) {
    return { error: `Keep the scopes every factory needs: ${dropped.join(", ")}.` };
  }
  const [updated] = await db
    .update(apps)
    .set({
      settings: sql`jsonb_set(${apps.settings}, '{scopes}', ${JSON.stringify(scopes)}::jsonb)`,
    })
    .where(
      and(eq(apps.id, appId), eq(apps.organizationId, organizationId), eq(apps.provider, "slack")),
    )
    .returning({ id: apps.id });
  if (!updated) return { error: "There is no such Slack app." };
  return { scopes };
}

// Slack asks receivers to refuse a request signed more than five minutes from now, against replays.
const MAX_REQUEST_AGE_S = 5 * 60;

const verifySignature = (
  secret: string,
  body: Buffer,
  timestamp: string | undefined,
  header: string | undefined,
) => {
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_REQUEST_AGE_S) return false;
  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest();
  const given = Buffer.from((header ?? "").replace(/^v0=/, ""), "hex");
  return (
    header?.startsWith("v0=") === true &&
    given.length === expected.length &&
    timingSafeEqual(given, expected)
  );
};

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  api_app_id?: string;
  team_id?: string;
  event_id?: string;
  event?: { type?: string };
}

/** Slack's Events API and the OAuth flow that installs a Slack app in a workspace. */
export function createSlackRoutes(options: {
  db: HubDatabase;
  waiters: MessageWaiters;
  encryptionKey: Buffer;
  publicUrl: URL;
  /** The Organization the request's signed-in user is an admin of, or `null`. */
  adminOrganization: (request: Request) => Promise<string | null>;
  /** Slack's Web API, replaced in tests. */
  apiUrl?: string;
}): Router {
  const { db, waiters, encryptionKey, publicUrl, adminOrganization } = options;
  const apiUrl = options.apiUrl ?? defaultApiUrl;
  const router = express.Router();
  const oauth = appOAuth({
    db,
    provider: "slack",
    label: "Slack",
    publicUrl,
    callbackPath: slackCallbackPath,
    adminOrganization,
  });

  const signingSecret = (app: App) =>
    decryptJson<SlackAppSecrets>(encryptionKey, app.secrets).signingSecret;

  router.post(slackWebhookPath, webhookBody, async (request, response) => {
    const body = request.body as Buffer;
    const signed = (app: App) =>
      verifySignature(
        signingSecret(app),
        body,
        request.get("x-slack-request-timestamp"),
        request.get("x-slack-signature"),
      );
    // Read before the signature check, since the body names the app whose secret signed it.
    const payload = parseWebhookJson<SlackEnvelope>(body, response);
    if (!payload) return;

    if (payload.type === "url_verification") {
      // The challenge names no app, so any Slack app's signing secret may have signed it.
      const slackApps = await db.query.apps.findMany({ where: eq(apps.provider, "slack") });
      if (!slackApps.some(signed)) {
        response.status(401).json({ error: "No Slack app on this hub signed this request." });
        return;
      }
      response.json({ challenge: payload.challenge });
      return;
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.provider, "slack"), eq(apps.externalId, payload.api_app_id ?? "")),
    });
    if (!app) {
      // A 200, so Slack stops retrying an event no one here can take.
      console.warn(`[slack] dropped a request for unknown Slack app ${payload.api_app_id}`);
      response.status(200).end();
      return;
    }
    if (!signed(app)) {
      response.status(401).json({ error: "The signature is not this Slack app's." });
      return;
    }
    if (payload.type !== "event_callback") {
      response.status(200).end();
      return;
    }
    const name = payload.event?.type ?? "";
    const installation = await db.query.installations.findFirst({
      where: and(
        eq(installations.appId, app.id),
        eq(installations.externalId, payload.team_id ?? ""),
      ),
    });
    if (!installation) {
      console.warn(
        `[slack] dropped ${name} for ${app.name}: workspace ${payload.team_id ?? "(none)"} has not installed it`,
      );
      response.status(200).end();
      return;
    }
    await fanOutProviderEvent(db, waiters, {
      organizationId: app.organizationId,
      appId: app.id,
      installationId: installation.id,
      provider: "slack",
      name,
      payload,
      // Slack sends an event again when an answer is slow; it is stored and sent once.
      dedupeKey: payload.event_id,
    });
    response.status(200).end();
  });

  router.get(slackInstallPath(":appId"), async (request, response) => {
    const app = await oauth.adminsApp(request, response);
    if (!app) return;
    const settings = app.settings as SlackAppSettings;
    const query = new URLSearchParams({
      client_id: settings.clientId,
      scope: settings.scopes.join(","),
      redirect_uri: oauth.callbackUrl(app),
      state: oauth.startState(response, app),
    });
    response.redirect(303, `${authorizeUrl}?${query}`);
  });

  router.get(slackCallbackPath(":appId"), async (request, response) => {
    const app = await oauth.adminsApp(request, response);
    if (!app || !oauth.checkCallback(request, response, app)) return;
    const { clientSecret } = decryptJson<SlackAppSecrets>(encryptionKey, app.secrets);
    const exchanged = await fetch(`${apiUrl}/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(request.query.code ?? ""),
        redirect_uri: oauth.callbackUrl(app),
        client_id: (app.settings as SlackAppSettings).clientId,
        client_secret: clientSecret,
      }),
    });
    const body = (await exchanged.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      access_token?: string;
      scope?: string;
      expires_in?: number;
      bot_user_id?: string;
      app_id?: string;
      team?: { id: string; name: string } | null;
    };
    if (!body.ok || !body.access_token || !body.bot_user_id) {
      response
        .status(502)
        .type("text")
        .send(`Slack refused the code (${body.error ?? exchanged.status}). Start again.`);
      return;
    }
    if (body.app_id !== app.externalId) {
      response
        .status(400)
        .type("text")
        .send(`Slack installed app ${body.app_id}, not ${app.externalId}. Check the app ID.`);
      return;
    }
    if (!body.team) {
      response
        .status(400)
        .type("text")
        .send("Install the app in one workspace; the hub does not take org-wide installs.");
      return;
    }
    if (body.expires_in !== undefined) {
      response
        .status(400)
        .type("text")
        .send(
          "Slack gave a token that expires: turn off token rotation in the app's OAuth & Permissions settings, then install again.",
        );
      return;
    }
    await recordInstallation(db, app, {
      externalId: body.team.id,
      account: body.team.name,
      settings: {
        botUserId: body.bot_user_id,
        scopes: (body.scope ?? "").split(",").filter(Boolean),
      } satisfies SlackWorkspaceSettings,
      secrets: encryptJson<SlackWorkspaceSecrets>(encryptionKey, { botToken: body.access_token }),
    });
    response.redirect(303, `/apps/${app.id}`);
  });

  return router;
}

/** The bot token of the named installation of a Slack app assigned to the factory. */
export async function issueSlackToken(
  db: HubDatabase,
  encryptionKey: Buffer,
  factoryId: string,
  installationName: string,
): Promise<{ token: SlackTokenResponse } | { status: 404; error: string }> {
  const found = await findNamedInstallation(db, factoryId, "slack", installationName);
  if ("error" in found) return found;
  const { app, installation } = found;
  const { botToken } = decryptJson<SlackWorkspaceSecrets>(
    encryptionKey,
    installation.secrets ?? "",
  );
  const { botUserId, scopes } = installation.settings as SlackWorkspaceSettings;
  return {
    token: {
      token: botToken,
      scopes,
      app: { appId: app.externalId, name: app.name, botUserId },
      team: installation.externalId,
    },
  };
}
