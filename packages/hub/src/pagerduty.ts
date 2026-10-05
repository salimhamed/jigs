import { createHmac, timingSafeEqual } from "node:crypto";
import { type PagerDutyTokenResponse, pagerDutyScopes } from "@jigs-ai/hub-protocol";
import { and, eq } from "drizzle-orm";
import express, { type Router } from "express";
import { findApp } from "./app-oauth.ts";
import type { App } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, assignments, installations } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

/** Where PagerDuty sends one PagerDuty app's webhooks. Its payloads do not name the app, so each has its own. */
export const pagerDutyWebhookPath = (appId: string) => `/webhooks/pagerduty/${appId}`;

/** The webhook event types factories hear. */
export const pagerDutyEventTypes = ["incident.triggered"] as const;

/** The regions PagerDuty hosts accounts in. */
export const pagerDutyRegions = ["us", "eu"] as const;

/** What the hub knows of an app's account, kept in `installations.settings`. Its subdomain is the account. */
export interface PagerDutyAccountSettings {
  region: (typeof pagerDutyRegions)[number];
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
}

const defaultIdentityUrl = "https://identity.pagerduty.com";

const readSecrets = (encryptionKey: Buffer, app: App): PagerDutyAppSecrets =>
  JSON.parse(decryptSecret(encryptionKey, app.secrets));

/** Mint an app token for the account with the client-credentials grant, or say why PagerDuty refused. */
async function mintToken(
  identityUrl: string,
  credentials: { clientId: string; clientSecret: string; subdomain: string; region: string },
  now = Date.now(),
): Promise<PagerDutyTokenResponse | { refused: number }> {
  const response = await fetch(`${identityUrl}/oauth/token`, {
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

/**
 * Add a PagerDuty app to an Organization with the account it acts in, once
 * PagerDuty mints a token with its credentials, or say what is wrong with the
 * input.
 */
export async function addPagerDutyApp(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  input: PagerDutyAppInput,
  identityUrl = defaultIdentityUrl,
): Promise<{ app: App } | { error: string }> {
  if (!input.name || !input.clientId || !input.clientSecret || !input.subdomain) {
    return { error: "Enter the name, client ID, client secret and account subdomain." };
  }
  if (!(pagerDutyRegions as readonly string[]).includes(input.region)) {
    return { error: "The region is us or eu." };
  }
  const minted = await mintToken(identityUrl, input);
  if ("refused" in minted) {
    return {
      error: `PagerDuty refused these credentials for ${input.subdomain} in ${input.region} (${minted.refused}).`,
    };
  }
  return db.transaction(async (tx) => {
    const [app] = await tx
      .insert(apps)
      .values({
        organizationId,
        provider: "pagerduty",
        name: input.name,
        externalId: input.clientId,
        settings: {},
        secrets: encryptSecret(
          encryptionKey,
          JSON.stringify({ clientSecret: input.clientSecret } satisfies PagerDutyAppSecrets),
        ),
      })
      .onConflictDoNothing()
      .returning();
    if (!app) {
      return {
        error: `The PagerDuty app with client ID ${input.clientId} is already on this hub.`,
      };
    }
    await tx.insert(installations).values({
      appId: app.id,
      externalId: `${input.region}.${input.subdomain}`,
      account: input.subdomain,
      settings: { region: input.region } as PagerDutyAccountSettings,
    });
    return { app };
  });
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
        secrets: encryptSecret(
          encryptionKey,
          JSON.stringify({
            ...readSecrets(encryptionKey, app),
            webhookSecret,
          } satisfies PagerDutyAppSecrets),
        ),
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

  router.post(
    pagerDutyWebhookPath(":appId"),
    express.raw({ type: () => true, limit: "25mb" }),
    async (request, response) => {
      const app = await findApp(db, "pagerduty", String(request.params.appId));
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
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
      const payload = JSON.parse(body.toString("utf8")) as { event?: { event_type?: string } };
      await fanOutProviderEvent(db, waiters, {
        organizationId: app.organizationId,
        appId: app.id,
        provider: "pagerduty",
        name: payload.event?.event_type ?? "",
        payload,
      });
      response.status(200).end();
    },
  );

  return router;
}

/** What {@link PagerDutyTokens.issue} answers: a token, or the status and message to refuse with. */
export type PagerDutyTokenResult =
  | { token: PagerDutyTokenResponse }
  | { status: 404 | 409 | 503; error: string };

/** Mints a fresh app token, on every request, for the one PagerDuty app assigned to a factory. */
export class PagerDutyTokens {
  readonly #db: HubDatabase;
  readonly #encryptionKey: Buffer;
  readonly #identityUrl: string;

  constructor(options: { db: HubDatabase; encryptionKey: Buffer; identityUrl?: string }) {
    this.#db = options.db;
    this.#encryptionKey = options.encryptionKey;
    this.#identityUrl = options.identityUrl ?? defaultIdentityUrl;
  }

  async issue(factoryId: string): Promise<PagerDutyTokenResult> {
    const found = await this.#db
      .select({ app: apps, installation: installations })
      .from(installations)
      .innerJoin(apps, eq(apps.id, installations.appId))
      .innerJoin(assignments, eq(assignments.appId, apps.id))
      .where(and(eq(assignments.factoryId, factoryId), eq(apps.provider, "pagerduty")));
    const [first] = found;
    if (!first) return { status: 404, error: "No PagerDuty app is assigned to this factory." };
    if (found.length > 1) {
      const names = found
        .map((row) => `${row.app.name} (${row.installation.account})`)
        .sort()
        .join(", ");
      return {
        status: 409,
        error: `More than one PagerDuty app is assigned to this factory, so assign one: ${names}.`,
      };
    }
    const { app, installation } = first;
    const minted = await mintToken(this.#identityUrl, {
      clientId: app.externalId,
      clientSecret: readSecrets(this.#encryptionKey, app).clientSecret,
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
}
