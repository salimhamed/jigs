import { createHmac } from "node:crypto";
import { factoryStatusPath, pagerDutyScopes, pagerDutyTokenPath } from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { beforeAll, expect } from "vitest";
import { type App, setAssignments } from "./apps.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import { readMessages } from "./messages.ts";
import {
  addPagerDutyApp,
  createPagerDutyRoutes,
  hasPagerDutyWebhookSecret,
  pagerDutyWebhookPath,
  setPagerDutyFrom,
  setPagerDutyWebhookSecret,
} from "./pagerduty.ts";
import { organizationId, setUpTestHub } from "./test-hub.ts";

const { db, encryptionKey, waiters, listen, serveHub, newFactory, requestToken, nameInstallation } =
  setUpTestHub();
let hub: string;
let identity: string;

// The fake PagerDuty identity server and REST API: each app's secret and the
// accounts it may act in, each account's users' emails, and the account each
// minted token acts in.
const clients = new Map<string, { secret: string; accounts: Set<string> }>();
const grants: { clientId: string; scope: string }[] = [];
const users = new Map<string, string[]>();
const tokenAccounts = new Map<string, string>();

function fakePagerDuty() {
  const app = express();
  app.get("/users", (request, response) => {
    const token = /^Bearer (\S+)$/.exec(request.get("authorization") ?? "")?.[1] ?? "";
    const account = tokenAccounts.get(token);
    if (!account) {
      response.status(401).json({ error: { message: "Unauthorized" } });
      return;
    }
    const query = String(request.query.query ?? "");
    response.json({
      users: (users.get(account) ?? [])
        .filter((email) => email.startsWith(query))
        .map((email) => ({ id: email, name: email, email })),
    });
  });
  return app.post("/oauth/token", express.urlencoded(), (request, response) => {
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
    tokenAccounts.set(`pdus+_${grants.length}`, account ?? "");
    response.json({
      access_token: `pdus+_${grants.length}`,
      scope: scopes.join(" "),
      token_type: "bearer",
      expires_in: 86400,
    });
  });
}

beforeAll(async () => {
  identity = await listen(fakePagerDuty());
  hub = await serveHub({
    routes: createPagerDutyRoutes({ db, waiters, encryptionKey }),
    apiUrls: { pagerduty: identity },
  });
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
  users.set(`as_account-us.${subdomain}`, ["oncall@example.com"]);
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
      from: "oncall@example.com",
    },
    { apiUrl: identity, restApiUrl: identity },
  );
  if ("error" in added) throw new Error(added.error);
  if (webhookSecret) {
    await setPagerDutyWebhookSecret(db, encryptionKey, organizationId, added.app.id, webhookSecret);
  }
  return added.app;
}

const accountOf = (app: App) => app.name.replace("Jigs ", "acme-");

const nameAccount = (app: App, installationName: string) =>
  nameInstallation(app.id, `us.${accountOf(app)}`, installationName);

const requestPagerDutyToken = (token: string, installationName: string) =>
  requestToken(pagerDutyTokenPath, token, { installationName });

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

dbTest("adds an app once PagerDuty mints a token for its account", async () => {
  clients.set("good", { secret: "s", accounts: new Set(["as_account-eu.acme"]) });
  users.set("as_account-eu.acme", ["oncall@example.com", "oncall@example.com.au"]);
  const input = {
    name: "Jigs",
    clientId: "good",
    clientSecret: "s",
    subdomain: "acme",
    region: "eu",
    from: "oncall@example.com",
  };
  const add = (changes: Partial<typeof input>, organization = organizationId) =>
    addPagerDutyApp(
      db,
      encryptionKey,
      organization,
      { ...input, ...changes },
      { apiUrl: identity, restApiUrl: identity },
    );

  expect(await add({ subdomain: "" })).toEqual({
    error: "Enter the name, client ID, client secret, account subdomain and from email.",
  });
  expect(await add({ from: "" })).toEqual({
    error: "Enter the name, client ID, client secret, account subdomain and from email.",
  });
  expect(await add({ from: "oncall@example" })).toEqual({
    error: "acme has no PagerDuty user with the email oncall@example.",
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
    expect.objectContaining({
      externalId: "eu.acme",
      account: "acme",
      settings: { region: "eu", from: "oncall@example.com" },
    }),
  ]);
  expect(await add({}, "other")).toEqual({
    error: "The PagerDuty app with client ID good is already on this hub.",
  });

  const setFrom = (from: string, organization = organizationId) =>
    setPagerDutyFrom(db, encryptionKey, organization, added.app.id, from, {
      apiUrl: identity,
      restApiUrl: identity,
    });
  expect(await setFrom("nobody@example.com")).toEqual({
    error: "acme has no PagerDuty user with the email nobody@example.com.",
  });
  expect(await setFrom("Oncall@Example.com.au", "other")).toEqual({
    error: "There is no such PagerDuty app.",
  });
  expect(await setFrom("oncall@example.com.au")).toEqual({ from: "oncall@example.com.au" });
  const [account] = await db
    .select()
    .from(schema.installations)
    .where(eq(schema.installations.appId, added.app.id));
  expect(account?.settings).toEqual({ region: "eu", from: "oncall@example.com.au" });

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
    event: { provider: "pagerduty", installationName: null, name: "incident.triggered", payload },
  });
  await nameAccount(app, "pd-events");
  expect(await readMessages(db, assigned.id)).toMatchObject([
    { event: { installationName: "pd-events" } },
  ]);
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

dbTest("mints a token of each named account of the assigned apps on every request", async () => {
  const { factory, token } = await newFactory();
  expect(await requestPagerDutyToken(token, "pd-first")).toEqual({
    status: 404,
    body: { error: "No PagerDuty installation named pd-first is assigned to this factory." },
  });
  const [app, second] = [await newApp(), await newApp()];
  await nameAccount(app, "pd-first");
  await nameAccount(second, "pd-second");
  await setAssignments(db, organizationId, app.id, [factory.id]);
  await setAssignments(db, organizationId, second.id, [factory.id]);
  const first = await requestPagerDutyToken(token, "pd-first");
  expect(first).toEqual({
    status: 200,
    body: {
      token: expect.stringMatching(/^pdus\+_/),
      expiresAt: expect.any(String),
      from: "oncall@example.com",
    },
  });
  expect(grants.at(-1)).toEqual({
    clientId: app.externalId,
    scope: [`as_account-us.${accountOf(app)}`, ...pagerDutyScopes].join(" "),
  });
  expect((await requestPagerDutyToken(token, "pd-first")).body.token).not.toBe(first.body.token);
  expect((await requestPagerDutyToken(token, "pd-second")).status).toBe(200);
  expect(grants.at(-1)?.clientId).toBe(second.externalId);
  expect((await requestPagerDutyToken("nope", "pd-first")).status).toBe(401);

  // The from email an admin changes on the hub is the one the next token carries.
  users.get(`as_account-us.${accountOf(app)}`)?.push("incidents@example.com");
  expect(
    await setPagerDutyFrom(db, encryptionKey, organizationId, app.id, "incidents@example.com", {
      apiUrl: identity,
      restApiUrl: identity,
    }),
  ).toEqual({ from: "incidents@example.com" });
  expect((await requestPagerDutyToken(token, "pd-first")).body.from).toBe("incidents@example.com");

  const status = await fetch(`${hub}${factoryStatusPath}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "jigs/1.2.3" },
  });
  expect((await status.json()).apps).toContainEqual({
    provider: "pagerduty",
    name: app.name,
    installations: [{ account: accountOf(app), installationName: "pd-first" }],
  });

  // PagerDuty stops taking the credentials, as when the app's secret is regenerated.
  const client = clients.get(app.externalId);
  if (client) client.secret = "regenerated";
  expect(await requestPagerDutyToken(token, "pd-first")).toEqual({
    status: 503,
    body: {
      error: `PagerDuty refused ${app.name}'s credentials for ${accountOf(app)} (401); remove the app on the hub and add it with working ones.`,
    },
  });
});
