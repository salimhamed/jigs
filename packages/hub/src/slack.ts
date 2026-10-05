import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SlackTokenResponse } from "@jigs-ai/hub-protocol";
import { and, eq, sql } from "drizzle-orm";
import express, { type Request, type Router } from "express";
import type { App } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, assignments, installations, providerEvents } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

/** Where Slack sends every Slack app's events, its Event Subscriptions "Request URL". */
export const slackWebhookPath = "/webhooks/slack";

/** Where an admin starts installing a Slack app to a workspace. */
export const slackInstallPath = (appId: string) => `/oauth/slack/${appId}/install`;

/** Where Slack returns after a workspace approves an app, its OAuth "Redirect URL". */
export const slackCallbackPath = (appId: string) => `/oauth/slack/${appId}/callback`;

/** The bot token scopes factories use. */
export const slackBotScopes = [
  "channels:history",
  "groups:history",
  "chat:write",
  "users:read",
  "users:read.email",
] as const;

/** The bot events factories hear. */
export const slackBotEvents = ["message.channels", "message.groups"] as const;

/** What the hub knows of a Slack app besides its secrets, kept in `apps.settings`. Its Slack app ID is its `externalId`. */
export interface SlackAppSettings {
  clientId: string;
}

/** What the hub knows of a workspace an app is installed in, kept in `installations.settings`. */
export interface SlackWorkspaceSettings {
  botUserId: string;
}

interface SlackAppSecrets {
  clientSecret: string;
  signingSecret: string;
}

interface SlackWorkspaceSecrets {
  botToken: string;
  /** Only when the app rotates its tokens. */
  expiresAt?: string;
}

/** What an admin copies from a Slack app they made by hand. */
export interface SlackAppInput extends SlackAppSecrets {
  name: string;
  appId: string;
  clientId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      settings: { clientId: input.clientId } satisfies SlackAppSettings,
      secrets: encryptSecret(
        encryptionKey,
        JSON.stringify({
          clientSecret: input.clientSecret,
          signingSecret: input.signingSecret,
        } satisfies SlackAppSecrets),
      ),
    })
    .onConflictDoNothing()
    .returning();
  if (!app) return { error: `The Slack app ${input.appId} is already on this hub.` };
  return { app };
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

const STATE_COOKIE = "hub_slack_state";

const readSecrets = <T>(encryptionKey: Buffer, stored: string): T =>
  JSON.parse(decryptSecret(encryptionKey, stored));

const readCookie = (request: Request, name: string) => {
  for (const part of (request.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
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

  const signingSecret = (app: App) =>
    readSecrets<SlackAppSecrets>(encryptionKey, app.secrets).signingSecret;

  router.post(
    slackWebhookPath,
    express.raw({ type: () => true, limit: "25mb" }),
    async (request, response) => {
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signed = (app: App) =>
        verifySignature(
          signingSecret(app),
          body,
          request.get("x-slack-request-timestamp"),
          request.get("x-slack-signature"),
        );
      let payload: SlackEnvelope;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        response.status(400).json({ error: "The body is not JSON." });
        return;
      }

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
      if (request.get("x-slack-retry-num") !== undefined && payload.event_id) {
        const [stored] = await db
          .select({ id: providerEvents.id })
          .from(providerEvents)
          .where(
            and(
              eq(providerEvents.appId, app.id),
              sql`${providerEvents.payload}->>'event_id' = ${payload.event_id}`,
            ),
          )
          .limit(1);
        if (stored) {
          response.status(200).end();
          return;
        }
      }
      await fanOutProviderEvent(db, waiters, {
        organizationId: app.organizationId,
        appId: app.id,
        provider: "slack",
        name,
        payload,
      });
      response.status(200).end();
    },
  );

  // The app, when the signed-in user is an admin of its Organization.
  const adminsApp = async (request: Request) => {
    const appId = String(request.params.appId);
    const app = UUID.test(appId)
      ? await db.query.apps.findFirst({
          where: and(eq(apps.id, appId), eq(apps.provider, "slack")),
        })
      : undefined;
    return app && (await adminOrganization(request)) === app.organizationId ? app : null;
  };

  const callbackUrl = (app: App) => `${publicUrl.origin}${slackCallbackPath(app.id)}`;
  const cookieOptions = (app: App) => ({
    httpOnly: true,
    secure: publicUrl.protocol === "https:",
    // Lax still sends it on Slack's top-level redirect back.
    sameSite: "lax" as const,
    path: slackCallbackPath(app.id),
  });

  router.get(slackInstallPath(":appId"), async (request, response) => {
    const app = await adminsApp(request);
    if (!app) {
      response.status(404).type("text").send("No Slack app of yours on this hub has that id.");
      return;
    }
    const state = randomBytes(32).toString("base64url");
    response.cookie(STATE_COOKIE, state, { ...cookieOptions(app), maxAge: 10 * 60 * 1000 });
    const query = new URLSearchParams({
      client_id: (app.settings as SlackAppSettings).clientId,
      scope: slackBotScopes.join(","),
      redirect_uri: callbackUrl(app),
      state,
    });
    response.redirect(303, `${authorizeUrl}?${query}`);
  });

  router.get(slackCallbackPath(":appId"), async (request, response) => {
    const app = await adminsApp(request);
    if (!app) {
      response.status(404).type("text").send("No Slack app of yours on this hub has that id.");
      return;
    }
    const expected = readCookie(request, STATE_COOKIE);
    response.clearCookie(STATE_COOKIE, cookieOptions(app));
    if (!expected || String(request.query.state ?? "") !== expected) {
      response
        .status(400)
        .type("text")
        .send("This answer from Slack is not for an install you started. Start again.");
      return;
    }
    if (request.query.error) {
      response
        .status(400)
        .type("text")
        .send(`Slack did not install the app: ${request.query.error}`);
      return;
    }
    const { clientSecret } = readSecrets<SlackAppSecrets>(encryptionKey, app.secrets);
    const exchanged = await fetch(`${apiUrl}/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(request.query.code ?? ""),
        redirect_uri: callbackUrl(app),
        client_id: (app.settings as SlackAppSettings).clientId,
        client_secret: clientSecret,
      }),
    });
    const body = (await exchanged.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      access_token?: string;
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
    const secrets: SlackWorkspaceSecrets = {
      botToken: body.access_token,
      ...(body.expires_in === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString() }),
    };
    const values = {
      account: body.team.name,
      settings: { botUserId: body.bot_user_id } satisfies SlackWorkspaceSettings,
      secrets: encryptSecret(encryptionKey, JSON.stringify(secrets)),
      failure: null,
    };
    await db
      .insert(installations)
      .values({ appId: app.id, externalId: body.team.id, ...values })
      .onConflictDoUpdate({ target: [installations.appId, installations.externalId], set: values });
    response.redirect(303, `/apps/${app.id}`);
  });

  return router;
}

/** The bot token of the one installation, among the Slack apps assigned to the factory, that the request matches. */
export async function issueSlackToken(
  db: HubDatabase,
  encryptionKey: Buffer,
  factoryId: string,
  request: { appId?: string; team?: string },
): Promise<{ token: SlackTokenResponse } | { status: 404 | 409; error: string }> {
  const found = await db
    .select({ app: apps, installation: installations })
    .from(installations)
    .innerJoin(apps, eq(apps.id, installations.appId))
    .innerJoin(assignments, eq(assignments.appId, apps.id))
    .where(
      and(
        eq(assignments.factoryId, factoryId),
        eq(apps.provider, "slack"),
        request.appId === undefined ? undefined : eq(apps.externalId, request.appId),
        request.team === undefined ? undefined : eq(installations.externalId, request.team),
      ),
    );
  const [first] = found;
  if (!first) {
    const named = [
      request.appId && `app ${request.appId}`,
      request.team && `workspace ${request.team}`,
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      status: 404,
      error: named
        ? `No installation of a Slack app assigned to this factory matches ${named}.`
        : "No Slack app assigned to this factory is installed in a workspace.",
    };
  }
  if (found.length > 1) {
    const names = found
      .map((row) => `${row.app.name} in ${row.installation.account}`)
      .sort()
      .join(", ");
    return {
      status: 409,
      error: `More than one Slack installation assigned to this factory matches, so name the app and workspace: ${names}.`,
    };
  }
  const { app, installation } = first;
  const secrets = readSecrets<SlackWorkspaceSecrets>(encryptionKey, installation.secrets ?? "");
  const { botUserId } = installation.settings as SlackWorkspaceSettings;
  return {
    token: {
      token: secrets.botToken,
      ...(secrets.expiresAt === undefined ? {} : { expiresAt: secrets.expiresAt }),
      app: { appId: app.externalId, name: app.name, botUserId },
      team: installation.externalId,
    },
  };
}
