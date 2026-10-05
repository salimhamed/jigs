import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { factoryStatusPath, pagerDutyTokenPath } from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, expect } from "vitest";
import { type App, setAssignments } from "./apps.ts";
import { connectDatabase, type HubDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { createTestDatabase, dbTest } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import { createFactoryApi } from "./factory-api.ts";
import { GitHubTokens } from "./github.ts";
import { LinearTokens } from "./linear.ts";
import { MessageWaiters, readMessages } from "./messages.ts";
import {
  addPagerDutyApp,
  createPagerDutyRoutes,
  hasPagerDutyWebhookSecret,
  PagerDutyTokens,
  pagerDutyCallbackPath,
  pagerDutyConnectPath,
  pagerDutyScopes,
  pagerDutyWebhookPath,
  setPagerDutyWebhookSecret,
} from "./pagerduty.ts";

const encryptionKey = randomBytes(32);
const organizationId = "acme";
const publicUrl = new URL("https://hub.example.test");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: HubDatabase;
const waiters = new MessageWaiters();
const servers: Server[] = [];
let hub: string;
let identity: string;
let pagerDutyTokens: PagerDutyTokens;

interface Account {
  id: string;
  subdomain: string;
  region: string;
  userId: string;
}

// The fake PagerDuty identity server: codes it handed out and live refresh tokens.
const codes = new Map<string, { clientId: string; challenge: string; account: Account }>();
const refreshTokens = new Map<string, { clientId: string; account: Account }>();
const clientSecrets = new Map<string, string>();
let issued = 0;
let refreshes = 0;

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const idToken = (account: Account) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        account_id: account.id,
        subdomain: account.subdomain,
        region: account.region,
        user_id: account.userId,
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");

function fakeIdentity() {
  const tokens = (clientId: string, account: Account) => {
    issued += 1;
    const refresh = `pdus+_refresh_${issued}`;
    refreshTokens.set(refresh, { clientId, account });
    return {
      access_token: `pdus+_access_${issued}`,
      refresh_token: refresh,
      id_token: idToken(account),
      token_type: "bearer",
      expires_in: 86400,
      scope: pagerDutyScopes.join(" "),
    };
  };
  return express().post("/oauth/token", express.urlencoded(), (request, response) => {
    const form = request.body as Record<string, string>;
    if (clientSecrets.get(form.client_id ?? "") !== form.client_secret) {
      response.status(401).json({ error: "invalid_client" });
      return;
    }
    if (form.grant_type === "authorization_code") {
      const granted = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      const challenge = createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url");
      if (!granted || granted.clientId !== form.client_id || granted.challenge !== challenge) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      response.json(tokens(granted.clientId, granted.account));
      return;
    }
    const granted = refreshTokens.get(form.refresh_token ?? "");
    refreshTokens.delete(form.refresh_token ?? "");
    if (form.grant_type !== "refresh_token" || !granted || granted.clientId !== form.client_id) {
      response.status(400).json({ error: "invalid_grant" });
      return;
    }
    refreshes += 1;
    response.json(tokens(granted.clientId, granted.account));
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = connectDatabase(database.url);
  await migrateDatabase(db);
  await db.insert(schema.organization).values([
    { id: organizationId, name: "Acme", slug: "acme", createdAt: new Date() },
    { id: "other", name: "Other", slug: "other", createdAt: new Date() },
  ]);
  identity = await listen(fakeIdentity());
  pagerDutyTokens = new PagerDutyTokens({ db, encryptionKey, identityUrl: identity });
  hub = await listen(
    express()
      .use(
        createPagerDutyRoutes({
          db,
          waiters,
          encryptionKey,
          publicUrl,
          // Stands in for the session: the header names the Organization the caller administers.
          adminOrganization: async (request) => request.get("x-admin-of") ?? null,
          identityUrl: identity,
        }),
      )
      .use(
        createFactoryApi({
          db,
          waiters,
          githubTokens: new GitHubTokens({ db, encryptionKey }),
          linearTokens: new LinearTokens({ db, encryptionKey }),
          pagerDutyTokens,
          encryptionKey,
        }),
      ),
  );
});

afterAll(async () => {
  waiters.close();
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await db?.$client.end();
  await database?.drop();
});

let appCount = 0;
async function newApp(webhookSecret: string | null = `pd_wh_${appCount + 1}`) {
  appCount += 1;
  const clientId = `client-${appCount}`;
  clientSecrets.set(clientId, `secret ${appCount}`);
  const added = await addPagerDutyApp(db, encryptionKey, organizationId, {
    name: `Jigs ${appCount}`,
    clientId,
    clientSecret: `secret ${appCount}`,
  });
  if ("error" in added) throw new Error(added.error);
  if (webhookSecret) {
    await setPagerDutyWebhookSecret(db, encryptionKey, organizationId, added.app.id, webhookSecret);
  }
  return added.app;
}

let accountCount = 0;
function newAccount(): Account {
  accountCount += 1;
  return {
    id: `P0ACCT${accountCount}`,
    subdomain: `acme-${accountCount}`,
    region: "us",
    userId: `P0USER${accountCount}`,
  };
}

let factoryCount = 0;
async function newFactory() {
  factoryCount += 1;
  return addFactory(db, organizationId, `factory ${factoryCount}`);
}

const cookieOf = (response: Response) =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function startConnect(app: App, admin: string | null = app.organizationId) {
  return fetch(`${hub}${pagerDutyConnectPath(app.id)}`, {
    redirect: "manual",
    headers: admin ? { "x-admin-of": admin } : {},
  });
}

async function callback(app: App, query: Record<string, string>, cookie: string, admin = true) {
  const response = await fetch(
    `${hub}${pagerDutyCallbackPath(app.id)}?${new URLSearchParams(query)}`,
    {
      redirect: "manual",
      headers: { cookie, ...(admin ? { "x-admin-of": app.organizationId } : {}) },
    },
  );
  return { status: response.status, location: response.headers.get("location") };
}

/** Approve the app in PagerDuty for the connection `started` began, returning the code and state. */
function approve(app: App, started: Response, account: Account) {
  const authorize = new URL(started.headers.get("location") ?? "");
  const code = `code-${crypto.randomUUID()}`;
  codes.set(code, {
    clientId: app.externalId,
    challenge: authorize.searchParams.get("code_challenge") ?? "",
    account,
  });
  return { code, state: authorize.searchParams.get("state") ?? "" };
}

/** Connect an account the way an admin does: start, approve in PagerDuty, come back. */
async function connect(app: App, account: Account) {
  const started = await startConnect(app);
  const answered = await callback(app, approve(app, started, account), cookieOf(started));
  expect(answered).toEqual({ status: 303, location: `/apps/${app.id}` });
}

const installationsOf = (app: App) =>
  db.select().from(schema.installations).where(eq(schema.installations.appId, app.id));

const triggered = () => ({
  event: {
    id: crypto.randomUUID(),
    event_type: "incident.triggered",
    resource_type: "incident",
    occurred_at: new Date().toISOString(),
    agent: null,
    client: null,
    data: { id: "Q0INCIDENT", type: "incident", title: "Disk full" },
  },
});

const sign = (secret: string, body: string) =>
  `v1=${createHmac("sha256", secret).update(body).digest("hex")}`;

async function deliver(app: App, payload: unknown, signature: (body: string) => string) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${hub}${pagerDutyWebhookPath(app.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pagerduty-signature": signature(body) },
    body,
  });
  return response.status;
}

async function requestToken(token: string) {
  const response = await fetch(`${hub}${pagerDutyTokenPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "jigs/1.2.3",
      "content-type": "application/json",
    },
    body: "{}",
  });
  return { status: response.status, body: await response.json() };
}

dbTest("connects an account through PagerDuty's OAuth flow with PKCE", async () => {
  const app = await newApp();
  const account = newAccount();
  const started = await startConnect(app);
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get("location") ?? "");
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${identity}/oauth/authorize`);
  expect(Object.fromEntries(authorize.searchParams)).toEqual({
    client_id: app.externalId,
    redirect_uri: `${publicUrl.origin}${pagerDutyCallbackPath(app.id)}`,
    response_type: "code",
    scope: pagerDutyScopes.join(" "),
    state: expect.stringMatching(/^[\w-]{43}$/),
    code_challenge: expect.stringMatching(/^[\w-]{43}$/),
    code_challenge_method: "S256",
  });
  expect(started.headers.get("set-cookie")).toMatch(/HttpOnly/i);

  await connect(app, account);
  const [row] = await installationsOf(app);
  expect(row).toMatchObject({
    externalId: account.id,
    account: account.subdomain,
    settings: { region: account.region, userId: account.userId },
    failure: null,
  });
  expect(row?.secrets).not.toContain("pdus");

  // A connection holds one account: connecting another replaces it.
  const next = newAccount();
  await connect(app, next);
  expect(await installationsOf(app)).toEqual([
    expect.objectContaining({ externalId: next.id, account: next.subdomain }),
  ]);
});

dbTest("refuses a callback whose state or verifier is not the admin's own", async () => {
  const app = await newApp();
  const account = newAccount();
  expect((await startConnect(app, null)).status).toBe(404);
  expect((await startConnect(app, "other")).status).toBe(404);

  const started = await startConnect(app);
  const { code, state } = approve(app, started, account);
  expect((await callback(app, { code, state }, "")).status).toBe(400);
  expect((await callback(app, { code, state: "guess" }, cookieOf(started))).status).toBe(400);
  expect((await callback(app, { code, state }, cookieOf(started), false)).status).toBe(404);
  expect((await callback(app, { error: "access_denied", state }, cookieOf(started))).status).toBe(
    400,
  );
  // A cookie from another start carries another verifier, which PagerDuty refuses.
  const otherStart = await startConnect(app);
  const otherState = new URL(otherStart.headers.get("location") ?? "").searchParams.get("state");
  expect(
    (await callback(app, { code, state: otherState ?? "" }, cookieOf(otherStart))).status,
  ).toBe(502);
  expect(await installationsOf(app)).toEqual([]);
});

dbTest("sends a signed event only to the app's factories", async () => {
  const app = await newApp("pd_secret");
  const other = await newApp("pd_other");
  const [assigned, unassigned] = [(await newFactory()).factory, (await newFactory()).factory];
  await setAssignments(db, organizationId, app.id, [assigned.id]);
  await setAssignments(db, organizationId, other.id, [unassigned.id]);

  const payload = triggered();
  expect(await deliver(app, payload, (body) => sign("pd_secret", body))).toBe(200);
  const [message] = await readMessages(db, assigned.id);
  expect(message).toMatchObject({
    kind: "event",
    event: { provider: "pagerduty", name: "incident.triggered", payload },
  });
  expect(await readMessages(db, unassigned.id)).toEqual([]);

  // While a secret rotates the header holds a signature for each; one match is enough.
  expect(
    await deliver(app, triggered(), (body) => `${sign("old", body)}, ${sign("pd_secret", body)}`),
  ).toBe(200);
  expect(await deliver(app, triggered(), (body) => sign("pd_other", body))).toBe(401);
  expect(await deliver(app, triggered(), () => "v1=00")).toBe(401);
  expect(await deliver(app, triggered(), () => "")).toBe(401);
  expect(
    await deliver({ ...app, id: crypto.randomUUID() }, triggered(), (body) =>
      sign("pd_secret", body),
    ),
  ).toBe(401);
  expect(await readMessages(db, assigned.id)).toHaveLength(2);

  // Until its signing secret is entered, a connection takes no webhooks.
  const unset = await newApp(null);
  expect(hasPagerDutyWebhookSecret(encryptionKey, unset)).toBe(false);
  expect(await deliver(unset, triggered(), (body) => sign("", body))).toBe(401);
});

dbTest("issues the token of the one connected PagerDuty app", async () => {
  const { factory, token } = await newFactory();
  expect(await requestToken(token)).toEqual({
    status: 404,
    body: { error: "No PagerDuty app assigned to this factory is connected to an account." },
  });
  const app = await newApp();
  const account = newAccount();
  await connect(app, account);
  await setAssignments(db, organizationId, app.id, [factory.id]);
  expect(await requestToken(token)).toEqual({
    status: 200,
    body: { token: expect.stringMatching(/^pdus\+_access_/), expiresAt: expect.any(String) },
  });
  expect((await requestToken("nope")).status).toBe(401);

  const status = await fetch(`${hub}${factoryStatusPath}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "jigs/1.2.3" },
  });
  expect((await status.json()).apps).toEqual([
    { provider: "pagerduty", name: app.name, installations: [{ account: account.subdomain }] },
  ]);

  const second = await newApp();
  await connect(second, newAccount());
  await setAssignments(db, organizationId, second.id, [factory.id]);
  expect((await requestToken(token)).status).toBe(409);
});

dbTest("refreshes a token near expiry once, and stops on a refused refresh", async () => {
  const app = await newApp();
  const account = newAccount();
  await connect(app, account);
  const { factory } = await newFactory();
  await setAssignments(db, organizationId, app.id, [factory.id]);
  const current = await pagerDutyTokens.issue(factory.id);
  if (!("token" in current)) throw new Error(current.error);

  const nearExpiry = Date.parse(current.token.expiresAt) - 4 * 60 * 1000;
  const before = refreshes;
  const [one, two] = await Promise.all([
    pagerDutyTokens.issue(factory.id, nearExpiry),
    pagerDutyTokens.issue(factory.id, nearExpiry),
  ]);
  expect(refreshes - before).toBe(1);
  expect(one).toEqual(two);
  if (!("token" in one)) throw new Error(one.error);
  expect(one.token.token).not.toBe(current.token.token);

  refreshTokens.clear();
  const later = Date.parse(one.token.expiresAt) - 60 * 1000;
  expect(await pagerDutyTokens.issue(factory.id, later)).toEqual({
    status: 503,
    error: `Connect ${account.subdomain} to ${app.name} again on the hub: PagerDuty refused to refresh the token (400).`,
  });
  const [row] = await installationsOf(app);
  expect(row?.failure).toBe("PagerDuty refused to refresh the token (400).");

  await connect(app, account);
  expect("token" in (await pagerDutyTokens.issue(factory.id))).toBe(true);
});

dbTest("validates a PagerDuty app, adds it once per hub and takes its signing secret", async () => {
  const input = { name: "Jigs", clientId: "dup", clientSecret: "s" };
  expect(
    await addPagerDutyApp(db, encryptionKey, organizationId, { ...input, clientSecret: "" }),
  ).toEqual({ error: "Enter the name, client ID and client secret." });
  const added = await addPagerDutyApp(db, encryptionKey, organizationId, input);
  if (!("app" in added)) throw new Error(added.error);
  expect(await addPagerDutyApp(db, encryptionKey, "other", input)).toEqual({
    error: "The PagerDuty app with client ID dup is already on this hub.",
  });
  expect(await setPagerDutyWebhookSecret(db, encryptionKey, "other", added.app.id, "w")).toBe(
    false,
  );
  expect(
    await setPagerDutyWebhookSecret(db, encryptionKey, organizationId, added.app.id, "w"),
  ).toBe(true);
  const [stored] = await db.select().from(schema.apps).where(eq(schema.apps.id, added.app.id));
  if (!stored) throw new Error("the app is gone");
  expect(hasPagerDutyWebhookSecret(encryptionKey, stored)).toBe(true);
  expect(stored.secrets).not.toContain("webhookSecret");
});
