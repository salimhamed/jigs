import { createHmac, timingSafeEqual } from "node:crypto";
import { type PagerDutyTokenResponse, pagerDutyScopes } from "@jigs-ai/hub-protocol";
import { and, eq } from "drizzle-orm";
import express, { type Router } from "express";
import { type App, findApp, findAssignedInstallation, recordInstallation } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, installations } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import { decryptJson, encryptJson } from "./secrets.ts";
import { parseWebhookJson, webhookBody } from "./webhooks.ts";

/** Where PagerDuty sends one PagerDuty app's webhooks. Its payloads do not name the app, so each has its own. */
export const pagerDutyWebhookPath = (appId: string) => `/webhooks/pagerduty/${appId}`;

/** The webhook event types factories hear. */
export const pagerDutyEventTypes = ["incident.triggered"] as const;

/** The regions PagerDuty hosts accounts in. */
export const pagerDutyRegions = ["us", "eu"] as const;

/** What the hub knows of an app's account, kept in `installations.settings`. Its subdomain is the account. */
export interface PagerDutyAccountSettings {
  region: (typeof pagerDutyRegions)[number];
  /** The email of the account's user that changes are made as, since PagerDuty requires one on a note. */
  from: string;
}

interface PagerDutyAppSecrets {
  clientSecret: string;
  /** The webhook subscription's, set once the subscription exists, since it needs the app's webhook URL. */
  webhookSecret?: string;
}

/** What an admin copies from a PagerDuty app they made by hand, and the account it acts in. */
export interface PagerDutyAppInput {
  name: string;
  clientId: string;
  clientSecret: string;
  subdomain: string;
  region: string;
  from: string;
}

/** PagerDuty's identity service, which mints app tokens, and its REST API; replaced in tests. */
export interface PagerDutyApiUrls {
  apiUrl?: string;
  restApiUrl?: string;
}

const defaultApiUrl = "https://identity.pagerduty.com";
const defaultRestApiUrl = "https://api.pagerduty.com";

const readSecrets = (encryptionKey: Buffer, app: App) =>
  decryptJson<PagerDutyAppSecrets>(encryptionKey, app.secrets);

/** Mint an app token for the account with the client-credentials grant, or say why PagerDuty refused. */
async function mintToken(
  apiUrl: string,
  credentials: { clientId: string; clientSecret: string; subdomain: string; region: string },
  now = Date.now(),
): Promise<PagerDutyTokenResponse | { refused: number }> {
  const response = await fetch(`${apiUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: [`as_account-${credentials.region}.${credentials.subdomain}`, ...pagerDutyScopes].join(
        " ",
      ),
    }),
  });
  if (response.status === 400 || response.status === 401) return { refused: response.status };
  if (!response.ok) throw new Error(`PagerDuty answered ${response.status} minting a token`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  return {
    token: body.access_token,
    expiresAt: new Date(now + body.expires_in * 1000).toISOString(),
  };
}

/** Why `from` cannot be the account's user, or `null` when a user has that email. */
async function checkFrom(
  restApiUrl: string,
  token: string,
  subdomain: string,
  from: string,
): Promise<string | null> {
  const response = await fetch(
    `${restApiUrl}/users?${new URLSearchParams({ query: from, limit: "100" })}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.pagerduty+json;version=2",
      },
    },
  );
  if (!response.ok) return `PagerDuty answered ${response.status} looking up ${from}.`;
  // `query` also matches names and email prefixes, so the match is made here.
  const { users } = (await response.json()) as { users: { email: string }[] };
  return users.some((user) => user.email.toLowerCase() === from.toLowerCase())
    ? null
    : `${subdomain} has no PagerDuty user with the email ${from}.`;
}

/**
 * Add a PagerDuty app to an Organization with the account it acts in, once
 * PagerDuty mints a token with its credentials and the account has the `from`
 * user, or say what is wrong with the input.
 */
export async function addPagerDutyApp(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  input: PagerDutyAppInput,
  { apiUrl = defaultApiUrl, restApiUrl = defaultRestApiUrl }: PagerDutyApiUrls = {},
): Promise<{ app: App } | { error: string }> {
  if (!input.name || !input.clientId || !input.clientSecret || !input.subdomain || !input.from) {
    return {
      error: "Enter the name, client ID, client secret, account subdomain and from email.",
    };
  }
  if (!(pagerDutyRegions as readonly string[]).includes(input.region)) {
    return { error: "The region is us or eu." };
  }
  const minted = await mintToken(apiUrl, input);
  if ("refused" in minted) {
    return {
      error: `PagerDuty refused these credentials for ${input.subdomain} in ${input.region} (${minted.refused}).`,
    };
  }
  const fromError = await checkFrom(restApiUrl, minted.token, input.subdomain, input.from);
  if (fromError) return { error: fromError };
  return db.transaction(async (tx) => {
    const [app] = await tx
      .insert(apps)
      .values({
        organizationId,
        provider: "pagerduty",
        name: input.name,
        externalId: input.clientId,
        settings: {},
        secrets: encryptJson<PagerDutyAppSecrets>(encryptionKey, {
          clientSecret: input.clientSecret,
        }),
      })
      .onConflictDoNothing()
      .returning();
    if (!app) {
      return {
        error: `The PagerDuty app with client ID ${input.clientId} is already on this hub.`,
      };
    }
    await recordInstallation(tx, app, {
      externalId: `${input.region}.${input.subdomain}`,
      account: input.subdomain,
      settings: {
        region: input.region as PagerDutyAccountSettings["region"],
        from: input.from,
      } satisfies PagerDutyAccountSettings,
    });
    return { app };
  });
}

/** Change the `from` email of an app's account, once the account has that user. */
export async function setPagerDutyFrom(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  appId: string,
  from: string,
  { apiUrl = defaultApiUrl, restApiUrl = defaultRestApiUrl }: PagerDutyApiUrls = {},
): Promise<{ from: string } | { error: string }> {
  if (!from) return { error: "Enter the email of a PagerDuty user." };
  const [found] = await db
    .select({ app: apps, installation: installations })
    .from(apps)
    .innerJoin(installations, eq(installations.appId, apps.id))
    .where(
      and(
        eq(apps.id, appId),
        eq(apps.organizationId, organizationId),
        eq(apps.provider, "pagerduty"),
      ),
    );
  if (!found) return { error: "There is no such PagerDuty app." };
  const { app, installation } = found;
  const settings = installation.settings as PagerDutyAccountSettings;
  const minted = await mintToken(apiUrl, {
    clientId: app.externalId,
    clientSecret: readSecrets(encryptionKey, app).clientSecret,
    subdomain: installation.account,
    region: settings.region,
  });
  if ("refused" in minted) {
    return {
      error: `PagerDuty refused ${app.name}'s credentials for ${installation.account} (${minted.refused}).`,
    };
  }
  const fromError = await checkFrom(restApiUrl, minted.token, installation.account, from);
  if (fromError) return { error: fromError };
  await db
    .update(installations)
    .set({ settings: { ...settings, from } satisfies PagerDutyAccountSettings })
    .where(eq(installations.id, installation.id));
  return { from };
}

/** Whether an admin has entered the app's webhook signing secret. */
export const hasPagerDutyWebhookSecret = (encryptionKey: Buffer, app: App) =>
  Boolean(readSecrets(encryptionKey, app).webhookSecret);

/** Set the signing secret of an app's webhook subscription. Returns `false` if there is no such app. */
export async function setPagerDutyWebhookSecret(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  appId: string,
  webhookSecret: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [app] = await tx
      .select()
      .from(apps)
      .where(
        and(
          eq(apps.id, appId),
          eq(apps.organizationId, organizationId),
          eq(apps.provider, "pagerduty"),
        ),
      )
      .for("update");
    if (!app) return false;
    await tx
      .update(apps)
      .set({
        secrets: encryptJson<PagerDutyAppSecrets>(encryptionKey, {
          ...readSecrets(encryptionKey, app),
          webhookSecret,
        }),
      })
      .where(eq(apps.id, appId));
    return true;
  });
}

// The header holds one `v1=<hex>` per signing secret while a secret rotates; any may match.
const verifySignature = (secret: string | undefined, body: Buffer, header: string | undefined) => {
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return (header ?? "").split(",").some((part) => {
    const signature = part.trim();
    if (!signature.startsWith("v1=")) return false;
    const given = Buffer.from(signature.slice(3), "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
};

/** PagerDuty's webhooks, one URL per app. */
export function createPagerDutyRoutes(options: {
  db: HubDatabase;
  waiters: MessageWaiters;
  encryptionKey: Buffer;
}): Router {
  const { db, waiters, encryptionKey } = options;
  const router = express.Router();

  router.post(pagerDutyWebhookPath(":appId"), webhookBody, async (request, response) => {
    const app = await findApp(db, "pagerduty", String(request.params.appId));
    const body = request.body as Buffer;
    if (
      !app ||
      !verifySignature(
        readSecrets(encryptionKey, app).webhookSecret,
        body,
        request.get("x-pagerduty-signature"),
      )
    ) {
      response
        .status(401)
        .json({ error: "The hub does not know this PagerDuty app or signature." });
      return;
    }
    const payload = parseWebhookJson<{ event?: { event_type?: string } }>(body, response);
    if (!payload) return;
    await fanOutProviderEvent(db, waiters, {
      organizationId: app.organizationId,
      appId: app.id,
      provider: "pagerduty",
      name: payload.event?.event_type ?? "",
      payload,
    });
    response.status(200).end();
  });

  return router;
}

/** A fresh app token, minted on every request, of the one PagerDuty app assigned to a factory. */
export async function issuePagerDutyToken(
  db: HubDatabase,
  encryptionKey: Buffer,
  factoryId: string,
  { apiUrl = defaultApiUrl }: { apiUrl?: string } = {},
): Promise<{ token: PagerDutyTokenResponse } | { status: 404 | 409 | 503; error: string }> {
  const found = await findAssignedInstallation(db, factoryId, "pagerduty", undefined, {
    none: "No PagerDuty app is assigned to this factory.",
    several: "More than one PagerDuty app is assigned to this factory, so assign one",
  });
  if ("error" in found) return found;
  const { app, installation } = found;
  const minted = await mintToken(apiUrl, {
    clientId: app.externalId,
    clientSecret: readSecrets(encryptionKey, app).clientSecret,
    subdomain: installation.account,
    region: (installation.settings as PagerDutyAccountSettings).region,
  });
  if ("refused" in minted) {
    return {
      status: 503,
      error: `PagerDuty refused ${app.name}'s credentials for ${installation.account} (${minted.refused}); remove the app on the hub and add it with working ones.`,
    };
  }
  return { token: minted };
}
