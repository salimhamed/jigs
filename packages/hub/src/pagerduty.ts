import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PagerDutyTokenResponse } from "@jigs-ai/hub-protocol";
import { and, eq, ne } from "drizzle-orm";
import express, { type Request, type Router } from "express";
import type { App } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, assignments, installations } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import {
  postForm,
  RefreshingTokens,
  readCookie,
  readSecrets,
  type TokenBody,
  toOAuthSecrets,
} from "./oauth.ts";
import { encryptSecret } from "./secrets.ts";

/** Where PagerDuty sends one PagerDuty app's webhooks. Its payloads do not name the app, so each has its own. */
export const pagerDutyWebhookPath = (appId: string) => `/webhooks/pagerduty/${appId}`;

/** Where an admin starts connecting a PagerDuty account to an app. */
export const pagerDutyConnectPath = (appId: string) => `/oauth/pagerduty/${appId}/connect`;

/** Where PagerDuty returns after someone approves an app, its "Redirect URL". */
export const pagerDutyCallbackPath = (appId: string) => `/oauth/pagerduty/${appId}/callback`;

/** The scopes the app grants factories, plus `openid` for the token that names the account. */
export const pagerDutyScopes = [
  "openid",
  "incidents.read",
  "incidents.write",
  "webhook_subscriptions.read",
  "users.read",
] as const;

/** The webhook event types factories hear. */
export const pagerDutyEventTypes = ["incident.triggered"] as const;

/** What the hub knows of a connected account besides its tokens, kept in `installations.settings`. Its subdomain is the account. */
export interface PagerDutyAccountSettings {
  region: string;
  /** The PagerDuty user who connected the account, whom the tokens act as. */
  userId: string;
}

interface PagerDutyAppSecrets {
  clientSecret: string;
  /** The webhook subscription's, set once the subscription exists, since it needs the app's webhook URL. */
  webhookSecret?: string;
}

/** What an admin copies from a PagerDuty app they made by hand. */
export interface PagerDutyAppInput {
  name: string;
  clientId: string;
  clientSecret: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultIdentityUrl = "https://identity.pagerduty.com";

/** Add a PagerDuty app to an Organization, or say what is wrong with the input. */
export async function addPagerDutyApp(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  input: PagerDutyAppInput,
): Promise<{ app: App } | { error: string }> {
  if (!input.name || !input.clientId || !input.clientSecret) {
    return { error: "Enter the name, client ID and client secret." };
  }
  const [app] = await db
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
    return { error: `The PagerDuty app with client ID ${input.clientId} is already on this hub.` };
  }
  return { app };
}

/** Whether an admin has entered the app's webhook signing secret. */
export const hasPagerDutyWebhookSecret = (encryptionKey: Buffer, app: App) =>
  Boolean(readSecrets<PagerDutyAppSecrets>(encryptionKey, app.secrets).webhookSecret);

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
    const secrets = readSecrets<PagerDutyAppSecrets>(encryptionKey, app.secrets);
    await tx
      .update(apps)
      .set({
        secrets: encryptSecret(
          encryptionKey,
          JSON.stringify({ ...secrets, webhookSecret } satisfies PagerDutyAppSecrets),
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

const STATE_COOKIE = "hub_pagerduty_state";

interface IdTokenClaims {
  account_id?: string;
  subdomain?: string;
  region?: string;
  user_id?: string;
}

// The id token comes straight from PagerDuty's token endpoint over TLS, so its claims are read unverified.
const idTokenClaims = (idToken: string | undefined): IdTokenClaims => {
  try {
    return JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
};

/** PagerDuty's webhooks and the OAuth flow that connects a PagerDuty account to an app. */
export function createPagerDutyRoutes(options: {
  db: HubDatabase;
  waiters: MessageWaiters;
  encryptionKey: Buffer;
  publicUrl: URL;
  /** The Organization the request's signed-in user is an admin of, or `null`. */
  adminOrganization: (request: Request) => Promise<string | null>;
  /** PagerDuty's OAuth server, replaced in tests. */
  identityUrl?: string;
}): Router {
  const { db, waiters, encryptionKey, publicUrl, adminOrganization } = options;
  const identityUrl = options.identityUrl ?? defaultIdentityUrl;
  const router = express.Router();

  const findApp = async (appId: string) =>
    UUID.test(appId)
      ? ((await db.query.apps.findFirst({
          where: and(eq(apps.id, appId), eq(apps.provider, "pagerduty")),
        })) ?? null)
      : null;

  // The app, when the signed-in user is an admin of its Organization.
  const adminsApp = async (request: Request) => {
    const app = await findApp(String(request.params.appId));
    return app && (await adminOrganization(request)) === app.organizationId ? app : null;
  };

  const callbackUrl = (app: App) => `${publicUrl.origin}${pagerDutyCallbackPath(app.id)}`;
  const cookieOptions = (app: App) => ({
    httpOnly: true,
    secure: publicUrl.protocol === "https:",
    // Lax still sends it on PagerDuty's top-level redirect back.
    sameSite: "lax" as const,
    path: pagerDutyCallbackPath(app.id),
  });

  router.post(
    pagerDutyWebhookPath(":appId"),
    express.raw({ type: () => true, limit: "25mb" }),
    async (request, response) => {
      const app = await findApp(String(request.params.appId));
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (
        !app ||
        !verifySignature(
          readSecrets<PagerDutyAppSecrets>(encryptionKey, app.secrets).webhookSecret,
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

  router.get(pagerDutyConnectPath(":appId"), async (request, response) => {
    const app = await adminsApp(request);
    if (!app) {
      response.status(404).type("text").send("No PagerDuty app of yours on this hub has that id.");
      return;
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    response.cookie(STATE_COOKIE, `${state}.${verifier}`, {
      ...cookieOptions(app),
      maxAge: 10 * 60 * 1000,
    });
    const query = new URLSearchParams({
      client_id: app.externalId,
      redirect_uri: callbackUrl(app),
      response_type: "code",
      scope: pagerDutyScopes.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    response.redirect(303, `${identityUrl}/oauth/authorize?${query}`);
  });

  router.get(pagerDutyCallbackPath(":appId"), async (request, response) => {
    const app = await adminsApp(request);
    if (!app) {
      response.status(404).type("text").send("No PagerDuty app of yours on this hub has that id.");
      return;
    }
    const [expected, verifier] = (readCookie(request, STATE_COOKIE) ?? "").split(".");
    response.clearCookie(STATE_COOKIE, cookieOptions(app));
    if (!expected || !verifier || String(request.query.state ?? "") !== expected) {
      response
        .status(400)
        .type("text")
        .send("This answer from PagerDuty is not for a connection you started. Start again.");
      return;
    }
    if (request.query.error) {
      response
        .status(400)
        .type("text")
        .send(
          `PagerDuty did not connect the account: ${request.query.error_description ?? request.query.error}`,
        );
      return;
    }
    const { clientSecret } = readSecrets<PagerDutyAppSecrets>(encryptionKey, app.secrets);
    const now = Date.now();
    const exchanged = await postForm(`${identityUrl}/oauth/token`, {
      grant_type: "authorization_code",
      code: String(request.query.code ?? ""),
      redirect_uri: callbackUrl(app),
      client_id: app.externalId,
      client_secret: clientSecret,
      code_verifier: verifier,
    });
    if (!exchanged.ok) {
      response
        .status(502)
        .type("text")
        .send(`PagerDuty refused the code (${exchanged.status}). Start again.`);
      return;
    }
    const body = (await exchanged.json()) as TokenBody & { id_token?: string };
    const claims = idTokenClaims(body.id_token);
    if (!claims.account_id || !claims.subdomain || !claims.region || !claims.user_id) {
      response
        .status(502)
        .type("text")
        .send("PagerDuty did not say which account it connected. Start again.");
      return;
    }
    const values = {
      account: claims.subdomain,
      settings: {
        region: claims.region,
        userId: claims.user_id,
      } satisfies PagerDutyAccountSettings,
      secrets: encryptSecret(encryptionKey, JSON.stringify(toOAuthSecrets(body, now))),
      failure: null,
    };
    // One account per app: its webhook URL cannot tell two apart.
    await db.transaction(async (tx) => {
      await tx
        .delete(installations)
        .where(
          and(
            eq(installations.appId, app.id),
            ne(installations.externalId, claims.account_id ?? ""),
          ),
        );
      await tx
        .insert(installations)
        .values({ appId: app.id, externalId: claims.account_id ?? "", ...values })
        .onConflictDoUpdate({
          target: [installations.appId, installations.externalId],
          set: values,
        });
    });
    response.redirect(303, `/apps/${app.id}`);
  });

  return router;
}

/** What {@link PagerDutyTokens.issue} answers: a token, or the status and message to refuse with. */
export type PagerDutyTokenResult =
  | { token: PagerDutyTokenResponse }
  | { status: 404 | 409 | 503; error: string };

/**
 * Hands out the access token of the PagerDuty account connected to a
 * factory's PagerDuty app, refreshing it as it nears expiry.
 */
export class PagerDutyTokens {
  readonly #db: HubDatabase;
  readonly #tokens: RefreshingTokens;

  constructor(options: { db: HubDatabase; encryptionKey: Buffer; identityUrl?: string }) {
    this.#db = options.db;
    this.#tokens = new RefreshingTokens({
      db: options.db,
      encryptionKey: options.encryptionKey,
      provider: "PagerDuty",
      tokenUrl: `${options.identityUrl ?? defaultIdentityUrl}/oauth/token`,
    });
  }

  /** The token of the account connected to the one PagerDuty app assigned to the factory. */
  async issue(factoryId: string, now = Date.now()): Promise<PagerDutyTokenResult> {
    const found = await this.#db
      .select({ app: apps, installation: installations })
      .from(installations)
      .innerJoin(apps, eq(apps.id, installations.appId))
      .innerJoin(assignments, eq(assignments.appId, apps.id))
      .where(and(eq(assignments.factoryId, factoryId), eq(apps.provider, "pagerduty")));
    const [first] = found;
    if (!first) {
      return {
        status: 404,
        error: "No PagerDuty app assigned to this factory is connected to an account.",
      };
    }
    if (found.length > 1) {
      const names = found
        .map((row) => `${row.app.name} (${row.installation.account})`)
        .sort()
        .join(", ");
      return {
        status: 409,
        error: `More than one PagerDuty app assigned to this factory is connected, so assign one: ${names}.`,
      };
    }
    const { app, installation } = first;
    const access = await this.#tokens.access(app, installation, now);
    if ("failure" in access) {
      return {
        status: 503,
        error: `Connect ${installation.account} to ${app.name} again on the hub: ${access.failure}`,
      };
    }
    return { token: access };
  }
}
