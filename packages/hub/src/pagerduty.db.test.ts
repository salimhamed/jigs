import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { factoryStatusPath, pagerDutyScopes, pagerDutyTokenPath } from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, expect } from "vitest";
import { type App, setAssignments } from "./apps.ts";
import { connectDatabase, type HubDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { createTestDatabase, dbTest } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import { createFactoryApi } from "./factory-api.ts";
import { LinearTokens } from "./linear.ts";
import { MessageWaiters, readMessages } from "./messages.ts";
import {
  addPagerDutyApp,
  createPagerDutyRoutes,
  hasPagerDutyWebhookSecret,
  pagerDutyWebhookPath,
  setPagerDutyWebhookSecret,
} from "./pagerduty.ts";

const encryptionKey = randomBytes(32);
const organizationId = "acme";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: HubDatabase;
const waiters = new MessageWaiters();
const servers: Server[] = [];
let hub: string;
let identity: string;

// The fake PagerDuty identity server: each app's secret and the accounts it may act in.
const clients = new Map<string, { secret: string; accounts: Set<string> }>();
const grants: { clientId: string; scope: string }[] = [];

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fakeIdentity() {
  return express().post("/oauth/token", express.urlencoded(), (request, response) => {
    const form = request.body as Record<string, string>;
    const client = clients.get(form.client_id ?? "");
    if (
      form.grant_type !== "client_credentials" ||
      !client ||
      client.secret !== form.client_secret
    ) {
      response.status(401).json({ error: "invalid_client" });
      return;
    }
    const [account, ...scopes] = (form.scope ?? "").split(" ");
    if (!client.accounts.has(account ?? "")) {
      response.status(400).json({ error: "invalid_scope" });
      return;
    }
    grants.push({ clientId: form.client_id ?? "", scope: form.scope ?? "" });
    response.json({
      access_token: `pdus+_${grants.length}`,
      scope: scopes.join(" "),
      token_type: "bearer",
      expires_in: 86400,
    });
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
  hub = await listen(
    express()
      .use(createPagerDutyRoutes({ db, waiters, encryptionKey }))
      .use(
        createFactoryApi({
          db,
          waiters,
          linearTokens: new LinearTokens({ db, encryptionKey }),
          pagerDutyIdentityUrl: identity,
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
  const subdomain = `acme-${appCount}`;
  clients.set(clientId, {
    secret: `secret ${appCount}`,
    accounts: new Set([`as_account-us.${subdomain}`]),
  });
  const added = await addPagerDutyApp(
    db,
    encryptionKey,
    organizationId,
    {
      name: `Jigs ${appCount}`,
      clientId,
      clientSecret: `secret ${appCount}`,
      subdomain,
      region: "us",
    },
    identity,
  );
  if ("error" in added) throw new Error(added.error);
  if (webhookSecret) {
    await setPagerDutyWebhookSecret(db, encryptionKey, organizationId, added.app.id, webhookSecret);
  }
  return added.app;
}

let factoryCount = 0;
async function newFactory() {
  factoryCount += 1;
  return addFactory(db, organizationId, `factory ${factoryCount}`);
}

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

dbTest("adds an app once PagerDuty mints a token for its account", async () => {
  clients.set("good", { secret: "s", accounts: new Set(["as_account-eu.acme"]) });
  const input = {
    name: "Jigs",
    clientId: "good",
    clientSecret: "s",
    subdomain: "acme",
    region: "eu",
  };
  const add = (changes: Partial<typeof input>, organization = organizationId) =>
    addPagerDutyApp(db, encryptionKey, organization, { ...input, ...changes }, identity);

  expect(await add({ subdomain: "" })).toEqual({
    error: "Enter the name, client ID, client secret and account subdomain.",
  });
  expect(await add({ region: "ap" })).toEqual({ error: "The region is us or eu." });
  expect(await add({ clientSecret: "wrong" })).toEqual({
    error: "PagerDuty refused these credentials for acme in eu (401).",
  });
  expect(await add({ region: "us" })).toEqual({
    error: "PagerDuty refused these credentials for acme in us (400).",
  });

  const added = await add({});
  if (!("app" in added)) throw new Error(added.error);
  expect(grants.at(-1)).toEqual({
    clientId: "good",
    scope: ["as_account-eu.acme", ...pagerDutyScopes].join(" "),
  });
  expect(
    await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.appId, added.app.id)),
  ).toEqual([
    expect.objectContaining({ externalId: "eu.acme", account: "acme", settings: { region: "eu" } }),
  ]);
  expect(await add({}, "other")).toEqual({
    error: "The PagerDuty app with client ID good is already on this hub.",
  });

  expect(hasPagerDutyWebhookSecret(encryptionKey, added.app)).toBe(false);
  expect(await setPagerDutyWebhookSecret(db, encryptionKey, "other", added.app.id, "w")).toBe(
    false,
  );
  expect(
    await setPagerDutyWebhookSecret(db, encryptionKey, organizationId, added.app.id, "w"),
  ).toBe(true);
  const stored = await db.query.apps.findFirst({ where: eq(schema.apps.id, added.app.id) });
  if (!stored) throw new Error("the app is gone");
  expect(hasPagerDutyWebhookSecret(encryptionKey, stored)).toBe(true);
  expect(stored.secrets).not.toContain("webhookSecret");
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

  // Until its signing secret is entered, an app takes no webhooks.
  const unset = await newApp(null);
  expect(await deliver(unset, triggered(), (body) => sign("", body))).toBe(401);
});

dbTest("mints a token of the one assigned app on every request", async () => {
  const { factory, token } = await newFactory();
  expect(await requestToken(token)).toEqual({
    status: 404,
    body: { error: "No PagerDuty app is assigned to this factory." },
  });
  const app = await newApp();
  await setAssignments(db, organizationId, app.id, [factory.id]);
  const first = await requestToken(token);
  expect(first).toEqual({
    status: 200,
    body: { token: expect.stringMatching(/^pdus\+_/), expiresAt: expect.any(String) },
  });
  expect(grants.at(-1)).toEqual({
    clientId: app.externalId,
    scope: [`as_account-us.${app.name.replace("Jigs ", "acme-")}`, ...pagerDutyScopes].join(" "),
  });
  expect((await requestToken(token)).body.token).not.toBe(first.body.token);
  expect((await requestToken("nope")).status).toBe(401);

  const status = await fetch(`${hub}${factoryStatusPath}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "jigs/1.2.3" },
  });
  expect((await status.json()).apps).toEqual([
    {
      provider: "pagerduty",
      name: app.name,
      installations: [{ account: app.name.replace("Jigs ", "acme-") }],
    },
  ]);

  // PagerDuty stops taking the credentials, as when the app's secret is regenerated.
  const client = clients.get(app.externalId);
  if (client) client.secret = "regenerated";
  expect(await requestToken(token)).toEqual({
    status: 503,
    body: {
      error: `PagerDuty refused ${app.name}'s credentials for ${app.name.replace("Jigs ", "acme-")} (401); remove the app on the hub and add it with working ones.`,
    },
  });

  const second = await newApp();
  await setAssignments(db, organizationId, second.id, [factory.id]);
  expect((await requestToken(token)).status).toBe(409);
});
