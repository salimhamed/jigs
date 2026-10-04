import {
  createHmac,
  createPrivateKey,
  createSign,
  hkdfSync,
  type KeyObject,
  timingSafeEqual,
} from "node:crypto";
import { and, eq } from "drizzle-orm";
import express, { type Router } from "express";
import { type App, recordInstallation, removeInstallation } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, installations } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";

/** Where GitHub sends every GitHub App's webhooks. */
export const githubWebhookPath = "/webhooks/github";

/** Where GitHub returns after someone installs a GitHub App, its "Setup URL". */
export const githubSetupPath = "/setup/github";

/** What a GitHub App's settings page shows, kept in `apps.settings`. */
export interface GitHubAppSettings {
  slug: string;
  clientId: string;
}

interface GitHubAppSecrets {
  privateKey: string;
  webhookSecret: string;
  clientSecret: string;
}

/** What an admin copies from a GitHub App they made by hand. */
export interface GitHubAppInput extends GitHubAppSettings, GitHubAppSecrets {
  appId: string;
}

/**
 * Add a GitHub App to an Organization, or say what is wrong with the input.
 * An App can belong to only one Organization on a hub.
 */
export async function addGitHubApp(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  input: GitHubAppInput,
): Promise<{ app: App } | { error: string }> {
  if (!/^\d+$/.test(input.appId)) return { error: "The App ID is a number." };
  if (!/^[a-z0-9-]+$/i.test(input.slug)) return { error: "The slug is the App's URL name." };
  if (!input.clientId || !input.clientSecret || !input.webhookSecret) {
    return { error: "Enter the client ID, client secret and webhook secret." };
  }
  try {
    createPrivateKey(input.privateKey);
  } catch {
    return { error: "The private key is not a PEM private key." };
  }
  const [app] = await db
    .insert(apps)
    .values({
      organizationId,
      provider: "github",
      name: input.slug,
      externalId: input.appId,
      settings: { slug: input.slug, clientId: input.clientId } satisfies GitHubAppSettings,
      secrets: encryptSecret(
        encryptionKey,
        JSON.stringify({
          privateKey: input.privateKey,
          webhookSecret: input.webhookSecret,
          clientSecret: input.clientSecret,
        } satisfies GitHubAppSecrets),
      ),
    })
    .onConflictDoNothing()
    .returning();
  if (!app) return { error: `GitHub App ${input.appId} is already on this hub.` };
  return { app };
}

const readSecrets = (encryptionKey: Buffer, app: App): GitHubAppSecrets =>
  JSON.parse(decryptSecret(encryptionKey, app.secrets));

const INSTALL_STATE_MS = 10 * 60 * 1000;

const stateKey = (encryptionKey: Buffer) =>
  Buffer.from(hkdfSync("sha256", encryptionKey, "", "jigs hub github install state", 32));

const signState = (encryptionKey: Buffer, body: string) =>
  createHmac("sha256", stateKey(encryptionKey)).update(body).digest("base64url");

/**
 * The GitHub page that installs an app. Its `state` binds the install to this
 * Organization and app for ten minutes, so the setup URL can trust it.
 */
export function githubInstallUrl(encryptionKey: Buffer, app: App, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({
      organizationId: app.organizationId,
      appId: app.id,
      expires: now + INSTALL_STATE_MS,
    }),
  ).toString("base64url");
  const state = `${body}.${signState(encryptionKey, body)}`;
  const { slug } = app.settings as GitHubAppSettings;
  return `https://github.com/apps/${slug}/installations/new?state=${state}`;
}

function readInstallState(
  encryptionKey: Buffer,
  state: string,
  now = Date.now(),
): { organizationId: string; appId: string } | null {
  const [body = "", signature = ""] = state.split(".");
  const expected = Buffer.from(signState(encryptionKey, body));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  return parsed.expires > now
    ? { organizationId: parsed.organizationId, appId: parsed.appId }
    : null;
}

/** A JSON Web Token that authenticates as the GitHub App itself, for ten minutes at most. */
export function githubAppJwt(appId: string, privateKey: string | KeyObject, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // Backdated a minute against clock drift, as GitHub advises.
  const header = encode({ alg: "RS256", typ: "JWT" });
  const unsigned = `${header}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

/** The account an App's installation is on, or `null` if GitHub says the App has no such installation. */
async function fetchInstallationAccount(
  apiUrl: string,
  app: App,
  secrets: GitHubAppSecrets,
  installationId: string,
): Promise<string | null> {
  const response = await fetch(`${apiUrl}/app/installations/${installationId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubAppJwt(app.externalId, secrets.privateKey)}`,
      "user-agent": "jigs-hub",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} reading installation ${installationId}`);
  }
  return accountName(await response.json());
}

interface InstallationBody {
  id?: number;
  account?: { login?: string; slug?: string } | null;
}

// An installation on an enterprise names it by slug instead of login.
const accountName = (installation: InstallationBody) =>
  installation.account?.login ?? installation.account?.slug ?? "";

const verifySignature = (secret: string, body: Buffer, header: string | undefined) => {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** GitHub's webhooks and the setup URL it returns to after an install. */
export function createGitHubRoutes(options: {
  db: HubDatabase;
  waiters: MessageWaiters;
  encryptionKey: Buffer;
  /** GitHub's REST API, replaced in tests. */
  apiUrl?: string;
}): Router {
  const { db, waiters, encryptionKey, apiUrl = "https://api.github.com" } = options;
  const router = express.Router();

  const findApp = async (appId: string) =>
    (await db.query.apps.findFirst({
      where: and(eq(apps.provider, "github"), eq(apps.externalId, appId)),
    })) ?? null;

  const hasInstallation = async (appId: string, installationId: number) =>
    (await db.query.installations.findFirst({
      columns: { id: true },
      where: and(
        eq(installations.appId, appId),
        eq(installations.externalId, String(installationId)),
      ),
    })) !== undefined;

  router.post(
    githubWebhookPath,
    // GitHub sends at most 25 MB.
    express.raw({ type: () => true, limit: "25mb" }),
    async (request, response) => {
      const app = await findApp(request.get("x-github-hook-installation-target-id") ?? "");
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (
        !app ||
        !verifySignature(
          readSecrets(encryptionKey, app).webhookSecret,
          body,
          request.get("x-hub-signature-256"),
        )
      ) {
        response.status(401).json({ error: "The hub does not know this GitHub App or signature." });
        return;
      }
      const name = request.get("x-github-event") ?? "";
      if (name === "ping") {
        response.status(200).end();
        return;
      }
      const payload = JSON.parse(body.toString("utf8")) as {
        action?: string;
        installation?: InstallationBody;
      };
      const installationId = payload.installation?.id;
      if (name === "installation" && installationId !== undefined) {
        if (payload.action === "deleted") {
          await removeInstallation(db, app.id, String(installationId));
        } else if (payload.action === "created") {
          await recordInstallation(
            db,
            app.id,
            String(installationId),
            accountName(payload.installation ?? {}),
          );
        }
      } else if (installationId === undefined || !(await hasInstallation(app.id, installationId))) {
        console.warn(
          `[github] dropped ${name} for ${app.name}: installation ${installationId ?? "(none)"} is not one of its installations`,
        );
        response.status(202).end();
        return;
      }
      await fanOutProviderEvent(db, waiters, {
        organizationId: app.organizationId,
        appId: app.id,
        provider: "github",
        name,
        payload,
      });
      response.status(200).end();
    },
  );

  router.get(githubSetupPath, async (request, response) => {
    const installationId = String(request.query.installation_id ?? "");
    if (!/^\d+$/.test(installationId)) {
      response.status(400).type("text").send("GitHub sent no installation.");
      return;
    }
    const state = request.query.state;
    if (typeof state !== "string") {
      // "Redirect on update" returns here without state after someone changes an installation.
      const known = await db.query.installations.findFirst({
        columns: { appId: true },
        where: eq(installations.externalId, installationId),
      });
      if (!known) {
        response.status(400).type("text").send("Install the app from its page on the hub.");
        return;
      }
      response.redirect(303, `/apps/${known.appId}`);
      return;
    }
    const bound = readInstallState(encryptionKey, state);
    const app =
      bound &&
      (await db.query.apps.findFirst({
        where: and(
          eq(apps.id, bound.appId),
          eq(apps.organizationId, bound.organizationId),
          eq(apps.provider, "github"),
        ),
      }));
    if (!app) {
      response
        .status(400)
        .type("text")
        .send("This install link has expired or is not from this hub. Install again from the hub.");
      return;
    }
    const account = await fetchInstallationAccount(
      apiUrl,
      app,
      readSecrets(encryptionKey, app),
      installationId,
    );
    if (account === null) {
      response
        .status(400)
        .type("text")
        .send(`GitHub has no installation ${installationId} of ${app.name}.`);
      return;
    }
    await recordInstallation(db, app.id, installationId, account);
    response.redirect(303, `/apps/${app.id}`);
  });

  return router;
}
