import {
  createHmac,
  createPrivateKey,
  createSign,
  type KeyObject,
  timingSafeEqual,
} from "node:crypto";
import type { GitHubTokenResponse } from "@jigs-ai/hub-protocol";
import { and, eq, sql } from "drizzle-orm";
import express, { type Router } from "express";
import {
  type App,
  findApp,
  findAssignedInstallation,
  type Installed,
  recordInstallation,
  recordInstallations,
  removeInstallation,
} from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, installations } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";
import { decryptJson, encryptJson } from "./secrets.ts";

/** Where GitHub sends every GitHub App's webhooks. */
export const githubWebhookPath = "/webhooks/github";

/** Where GitHub returns after someone installs or changes an installation of an App, its "Setup URL". */
export const githubSetupPath = (appId: string) => `/setup/github/${appId}`;

/** What the hub knows of a GitHub App besides its secrets, kept in `apps.settings`. Its slug is the app's name. */
export interface GitHubAppSettings {
  clientId: string;
  /** The user id of `<slug>[bot]`, learned the first time the hub issues the App a token. */
  botUserId?: number;
}

interface GitHubAppSecrets {
  privateKey: string;
  webhookSecret: string;
  clientSecret: string;
}

/** What an admin copies from a GitHub App they made by hand. */
export interface GitHubAppInput extends GitHubAppSecrets {
  appId: string;
  slug: string;
  clientId: string;
}

const defaultApiUrl = "https://api.github.com";

/**
 * Add a GitHub App to an Organization with every installation it already has,
 * or say what is wrong with the input. An App can belong to only one
 * Organization on a hub.
 */
export async function addGitHubApp(
  db: HubDatabase,
  encryptionKey: Buffer,
  organizationId: string,
  input: GitHubAppInput,
  apiUrl = defaultApiUrl,
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
  const installed = await listInstallations(apiUrl, input.appId, input.privateKey);
  if ("status" in installed) {
    return {
      error: `GitHub refused App ${input.appId} with this private key (${installed.status}).`,
    };
  }
  return db.transaction(async (tx) => {
    const [app] = await tx
      .insert(apps)
      .values({
        organizationId,
        provider: "github",
        name: input.slug,
        externalId: input.appId,
        settings: { clientId: input.clientId } satisfies GitHubAppSettings,
        secrets: encryptJson<GitHubAppSecrets>(encryptionKey, {
          privateKey: input.privateKey,
          webhookSecret: input.webhookSecret,
          clientSecret: input.clientSecret,
        }),
      })
      .onConflictDoNothing()
      .returning();
    if (!app) return { error: `GitHub App ${input.appId} is already on this hub.` };
    await recordInstallations(tx, app.id, installed.installations);
    return { app };
  });
}

/** The page on GitHub that installs an App. */
export const githubInstallUrl = (app: App) =>
  `https://github.com/apps/${app.name}/installations/new`;

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

const bearerHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "user-agent": "jigs-hub",
  "x-github-api-version": "2022-11-28",
});

const githubHeaders = (appId: string, privateKey: string) =>
  bearerHeaders(githubAppJwt(appId, privateKey));

/** Every installation GitHub has of the App, or the status GitHub refused with. */
async function listInstallations(
  apiUrl: string,
  appId: string,
  privateKey: string,
): Promise<{ installations: Installed[] } | { status: number }> {
  const installed: Installed[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${apiUrl}/app/installations?per_page=100&page=${page}`, {
      headers: githubHeaders(appId, privateKey),
    });
    if (!response.ok) return { status: response.status };
    const batch = (await response.json()) as InstallationBody[];
    for (const installation of batch) {
      installed.push({ externalId: String(installation.id), account: accountName(installation) });
    }
    if (batch.length < 100) return { installations: installed };
  }
}

/** The account an App's installation is on, or `null` if GitHub says the App has no such installation. */
async function fetchInstallationAccount(
  apiUrl: string,
  app: App,
  secrets: GitHubAppSecrets,
  installationId: string,
): Promise<string | null> {
  const response = await fetch(`${apiUrl}/app/installations/${installationId}`, {
    headers: githubHeaders(app.externalId, secrets.privateKey),
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
  const { db, waiters, encryptionKey, apiUrl = defaultApiUrl } = options;
  const router = express.Router();

  const findAppByGitHubId = async (appId: string) =>
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

  // An installation the hub missed, such as one made while the hub was down, is
  // learned from GitHub before its event is dropped.
  const knowsInstallation = async (app: App, installationId: number) => {
    if (await hasInstallation(app.id, installationId)) return true;
    const { privateKey } = decryptJson<GitHubAppSecrets>(encryptionKey, app.secrets);
    const installed = await listInstallations(apiUrl, app.externalId, privateKey);
    if ("status" in installed) {
      throw new Error(`GitHub answered ${installed.status} listing ${app.name}'s installations`);
    }
    await recordInstallations(db, app.id, installed.installations);
    return installed.installations.some((row) => row.externalId === String(installationId));
  };

  router.post(
    githubWebhookPath,
    // GitHub sends at most 25 MB.
    express.raw({ type: () => true, limit: "25mb" }),
    async (request, response) => {
      const app = await findAppByGitHubId(
        request.get("x-github-hook-installation-target-id") ?? "",
      );
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (
        !app ||
        !verifySignature(
          decryptJson<GitHubAppSecrets>(encryptionKey, app.secrets).webhookSecret,
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
          await recordInstallation(db, app.id, {
            externalId: String(installationId),
            account: accountName(payload.installation ?? {}),
          });
        }
      } else if (installationId === undefined || !(await knowsInstallation(app, installationId))) {
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

  // GitHub's call proves the installation is this App's, and an App is one Organization's.
  router.get(githubSetupPath(":appId"), async (request, response) => {
    const installationId = String(request.query.installation_id ?? "");
    const app = await findApp(db, "github", String(request.params.appId));
    if (!app || !/^\d+$/.test(installationId)) {
      response.status(400).type("text").send("GitHub sent no installation of an App on this hub.");
      return;
    }
    const account = await fetchInstallationAccount(
      apiUrl,
      app,
      decryptJson<GitHubAppSecrets>(encryptionKey, app.secrets),
      installationId,
    );
    if (account === null) {
      response
        .status(400)
        .type("text")
        .send(`GitHub has no installation ${installationId} of ${app.name}.`);
      return;
    }
    await recordInstallation(db, app.id, { externalId: installationId, account });
    response.redirect(303, `/apps/${app.id}`);
  });

  return router;
}

/**
 * A token of the one GitHub App assigned to the factory that is installed on
 * `owner`, minted fresh for every request and kept nowhere: the factory caches
 * its own, and asks again only when it needs a longer-lived token or GitHub
 * rejected the last.
 */
export async function issueGitHubToken(
  db: HubDatabase,
  encryptionKey: Buffer,
  factoryId: string,
  owner: string,
  apiUrl = defaultApiUrl,
): Promise<{ token: GitHubTokenResponse } | { status: 404 | 409; error: string }> {
  const found = await findAssignedInstallation(
    db,
    factoryId,
    "github",
    sql`lower(${installations.account}) = lower(${owner})`,
    {
      none: `No GitHub App assigned to this factory is installed on ${owner}.`,
      several: `More than one GitHub App assigned to this factory is installed on ${owner}`,
    },
  );
  if ("error" in found) return found;
  const { app, installation } = found;
  const { privateKey } = decryptJson<GitHubAppSecrets>(encryptionKey, app.secrets);
  const response = await fetch(
    `${apiUrl}/app/installations/${installation.externalId}/access_tokens`,
    { method: "POST", headers: githubHeaders(app.externalId, privateKey) },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status} minting a token for ${app.name}'s installation ${installation.externalId}`,
    );
  }
  const { token, expires_at } = (await response.json()) as { token: string; expires_at: string };
  const botUserId = await readBotUserId(db, apiUrl, app, token);
  return { token: { token, expiresAt: expires_at, app: { slug: app.name, botUserId } } };
}

async function readBotUserId(
  db: HubDatabase,
  apiUrl: string,
  app: App,
  token: string,
): Promise<number> {
  const settings = app.settings as GitHubAppSettings;
  if (settings.botUserId !== undefined) return settings.botUserId;
  const response = await fetch(`${apiUrl}/users/${encodeURIComponent(`${app.name}[bot]`)}`, {
    headers: bearerHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} reading the user ${app.name}[bot]`);
  }
  const { id } = (await response.json()) as { id: number };
  await db
    .update(apps)
    .set({ settings: { ...settings, botUserId: id } satisfies GitHubAppSettings })
    .where(eq(apps.id, app.id));
  return id;
}
