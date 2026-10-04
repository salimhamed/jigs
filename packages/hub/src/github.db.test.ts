import { createHmac, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, expect } from "vitest";
import { type App, setAssignments } from "./apps.ts";
import { connectDatabase, type HubDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { createTestDatabase, dbTest } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import {
  addGitHubApp,
  createGitHubRoutes,
  githubInstallUrl,
  githubSetupPath,
  githubWebhookPath,
} from "./github.ts";
import { MessageWaiters, readMessages } from "./messages.ts";

const encryptionKey = randomBytes(32);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const organizationId = "acme";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: HubDatabase;
const waiters = new MessageWaiters();
const servers: Server[] = [];
let hub: string;
let github: string;
// The fake GitHub's installations, by installation id: the App ID and account.
const githubInstallations = new Map<string, { appId: string; login: string }>();

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// GitHub's `GET /app/installations/{id}`, answering only an App JWT signed with its key.
function fakeGitHub() {
  return express().get("/app/installations/:id", (request, response) => {
    const [header = "", payload = "", signature = ""] = (request.get("authorization") ?? "")
      .replace(/^Bearer /, "")
      .split(".");
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature, "base64url");
    if (!verified) {
      response.status(401).json({ message: "A JSON web token could not be decoded" });
      return;
    }
    const { iss } = JSON.parse(Buffer.from(payload, "base64url").toString());
    const installation = githubInstallations.get(request.params.id);
    if (installation?.appId !== String(iss)) {
      response.status(404).json({ message: "Not Found" });
      return;
    }
    response.json({
      id: Number(request.params.id),
      account: { login: installation.login, id: 1, type: "Organization" },
      app_id: Number(iss),
      target_type: "Organization",
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
  github = await listen(fakeGitHub());
  hub = await listen(
    express().use(createGitHubRoutes({ db, waiters, encryptionKey, apiUrl: github })),
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
async function newApp(organization = organizationId) {
  appCount += 1;
  const webhookSecret = `secret ${appCount}`;
  const added = await addGitHubApp(db, encryptionKey, organization, {
    appId: String(1000 + appCount),
    slug: `jigs-${appCount}`,
    clientId: `Iv1.${appCount}`,
    clientSecret: "client secret",
    webhookSecret,
    privateKey: pem,
  });
  if ("error" in added) throw new Error(added.error);
  return { app: added.app, webhookSecret };
}

let factoryCount = 0;
async function newFactory(organization = organizationId) {
  factoryCount += 1;
  return (await addFactory(db, organization, `factory ${factoryCount}`)).factory;
}

let installationCount = 0;
async function installed(app: App) {
  installationCount += 1;
  const id = String(5000 + installationCount);
  await db.insert(schema.installations).values({ appId: app.id, externalId: id, account: "acme" });
  return Number(id);
}

const issueOpened = (installationId: number) => ({
  action: "opened",
  issue: {
    id: 1,
    node_id: "I_1",
    number: 7,
    title: "Widgets are slow",
    state: "open",
    user: { login: "octocat", id: 1, type: "User" },
    labels: [],
    body: "They are.",
  },
  repository: {
    id: 42,
    node_id: "R_42",
    name: "widgets",
    full_name: "acme/widgets",
    private: true,
    owner: { login: "acme", id: 2, type: "Organization" },
  },
  organization: { login: "acme", id: 2 },
  sender: { login: "octocat", id: 1, type: "User" },
  installation: { id: installationId, node_id: "MDIz" },
});

const installationEvent = (action: string, app: App, installationId: number, login: string) => ({
  action,
  installation: {
    id: installationId,
    account: { login, id: 2, type: "Organization" },
    app_id: Number(app.externalId),
    app_slug: app.name,
    target_type: "Organization",
    repository_selection: "all",
    permissions: { issues: "write", metadata: "read" },
    events: ["issues"],
  },
  repositories: [{ id: 42, name: "widgets", full_name: `${login}/widgets`, private: true }],
  sender: { login: "octocat", id: 1, type: "User" },
});

async function deliver(
  app: { app: App; webhookSecret: string },
  event: string,
  payload: unknown,
  sign: (body: string) => string | undefined = (body) =>
    `sha256=${createHmac("sha256", app.webhookSecret).update(body).digest("hex")}`,
) {
  const body = JSON.stringify(payload);
  const signature = sign(body);
  const response = await fetch(`${hub}${githubWebhookPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/abc123",
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      "x-github-hook-id": "1",
      "x-github-hook-installation-target-id": app.app.externalId,
      "x-github-hook-installation-target-type": "integration",
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
  return response.status;
}

const eventNames = async (factoryId: string) =>
  (await readMessages(db, factoryId)).map((message) =>
    message.kind === "event" ? message.event.name : message.kind,
  );

const providerEventsOf = (app: App) =>
  db.select().from(schema.providerEvents).where(eq(schema.providerEvents.appId, app.id));

dbTest("stores a signed event once and sends it only to the app's factories", async () => {
  const github = await newApp();
  const otherApp = await newApp();
  const [assigned, alsoAssigned, unassigned] = [
    await newFactory(),
    await newFactory(),
    await newFactory(),
  ];
  await setAssignments(db, organizationId, github.app.id, [assigned.id, alsoAssigned.id]);
  await setAssignments(db, organizationId, otherApp.app.id, [unassigned.id]);
  const installationId = await installed(github.app);

  expect(await deliver(github, "issues", issueOpened(installationId))).toBe(200);

  const [stored] = await providerEventsOf(github.app);
  expect(stored).toMatchObject({
    organizationId,
    provider: "github",
    name: "issues",
    payload: issueOpened(installationId),
  });
  const [message] = await readMessages(db, assigned.id);
  expect(message).toMatchObject({ kind: "event", event: { id: stored?.id, name: "issues" } });
  expect(await eventNames(alsoAssigned.id)).toEqual(["issues"]);
  expect(await eventNames(unassigned.id)).toEqual([]);
});

dbTest("answers ping without storing it", async () => {
  const github = await newApp();
  const factory = await newFactory();
  await setAssignments(db, organizationId, github.app.id, [factory.id]);
  expect(await deliver(github, "ping", { zen: "Keep it logically awesome.", hook_id: 1 })).toBe(
    200,
  );
  expect(await providerEventsOf(github.app)).toEqual([]);
});

dbTest("refuses unknown apps and bad signatures", async () => {
  const github = await newApp();
  const other = await newApp();
  const installationId = await installed(github.app);
  const payload = issueOpened(installationId);

  expect(await deliver(github, "issues", payload, () => undefined)).toBe(401);
  expect(await deliver(github, "issues", payload, () => "sha256=00")).toBe(401);
  expect(
    await deliver(
      github,
      "issues",
      payload,
      (body) => `sha256=${createHmac("sha256", other.webhookSecret).update(body).digest("hex")}`,
    ),
  ).toBe(401);
  const unknown = { ...github, app: { ...github.app, externalId: "999999" } };
  expect(await deliver(unknown, "issues", payload)).toBe(401);
  expect(await providerEventsOf(github.app)).toEqual([]);
});

dbTest("drops events from installations that are not the app's", async () => {
  const github = await newApp();
  const other = await newApp();
  const factory = await newFactory();
  await setAssignments(db, organizationId, github.app.id, [factory.id]);
  const othersInstallation = await installed(other.app);

  expect(await deliver(github, "issues", issueOpened(othersInstallation))).toBe(202);
  expect(await deliver(github, "issues", issueOpened(987654))).toBe(202);
  const { installation: _, ...withoutInstallation } = issueOpened(1);
  expect(await deliver(github, "issues", withoutInstallation)).toBe(202);
  expect(await providerEventsOf(github.app)).toEqual([]);
  expect(await eventNames(factory.id)).toEqual([]);
});

dbTest("keeps installations current from installation events", async () => {
  const github = await newApp();
  const factory = await newFactory();
  await setAssignments(db, organizationId, github.app.id, [factory.id]);
  const installationsOf = () =>
    db
      .select({
        externalId: schema.installations.externalId,
        account: schema.installations.account,
      })
      .from(schema.installations)
      .where(eq(schema.installations.appId, github.app.id));

  expect(
    await deliver(github, "installation", installationEvent("created", github.app, 77, "acme")),
  ).toBe(200);
  expect(await installationsOf()).toEqual([{ externalId: "77", account: "acme" }]);
  expect(await deliver(github, "issues", issueOpened(77))).toBe(200);

  expect(
    await deliver(github, "installation", installationEvent("deleted", github.app, 77, "acme")),
  ).toBe(200);
  expect(await installationsOf()).toEqual([]);
  expect(await deliver(github, "issues", issueOpened(77))).toBe(202);
  expect(await eventNames(factory.id)).toEqual(["installation", "issues", "installation"]);
});

async function setup(query: Record<string, string>) {
  const response = await fetch(`${hub}${githubSetupPath}?${new URLSearchParams(query)}`, {
    redirect: "manual",
  });
  return { status: response.status, location: response.headers.get("location") };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";

dbTest("records an installation GitHub confirms for the app the install link names", async () => {
  const github = await newApp();
  const other = await newApp();
  githubInstallations.set("31", { appId: github.app.externalId, login: "acme-corp" });
  githubInstallations.set("32", { appId: other.app.externalId, login: "elsewhere" });
  const installUrl = githubInstallUrl(encryptionKey, github.app);
  expect(installUrl).toMatch(
    new RegExp(`^https://github.com/apps/${github.app.name}/installations/new\\?state=`),
  );
  const state = stateOf(installUrl);

  expect(await setup({ installation_id: "32", setup_action: "install", state })).toMatchObject({
    status: 400,
  });
  expect(await setup({ installation_id: "31", setup_action: "install", state })).toEqual({
    status: 303,
    location: `/apps/${github.app.id}`,
  });
  const recorded = await db
    .select({ externalId: schema.installations.externalId, account: schema.installations.account })
    .from(schema.installations)
    .where(eq(schema.installations.appId, github.app.id));
  expect(recorded).toEqual([{ externalId: "31", account: "acme-corp" }]);

  // An update returns without state, to the page of the app that has the installation.
  expect(await setup({ installation_id: "31", setup_action: "update" })).toEqual({
    status: 303,
    location: `/apps/${github.app.id}`,
  });
  expect(await setup({ installation_id: "32", setup_action: "update" })).toMatchObject({
    status: 400,
  });
});

dbTest("refuses install links that are forged, altered or expired", async () => {
  const github = await newApp();
  githubInstallations.set("41", { appId: github.app.externalId, login: "acme" });
  const state = stateOf(githubInstallUrl(encryptionKey, github.app));
  const [body = "", signature = ""] = state.split(".");
  const forged = stateOf(githubInstallUrl(randomBytes(32), github.app));
  const altered = `${Buffer.from(
    Buffer.from(body, "base64url").toString().replace(github.app.id, crypto.randomUUID()),
  ).toString("base64url")}.${signature}`;
  const expired = stateOf(githubInstallUrl(encryptionKey, github.app, Date.now() - 11 * 60_000));

  for (const bad of [forged, altered, expired, "nonsense"]) {
    expect(
      await setup({ installation_id: "41", setup_action: "install", state: bad }),
    ).toMatchObject({ status: 400 });
  }
  expect(
    await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.appId, github.app.id)),
  ).toEqual([]);
});

dbTest("validates a GitHub App before adding it, once per hub", async () => {
  const input = {
    appId: "424242",
    slug: "jigs-acme",
    clientId: "Iv1.abc",
    clientSecret: "s",
    webhookSecret: "w",
    privateKey: pem,
  };
  expect(await addGitHubApp(db, encryptionKey, organizationId, { ...input, appId: "x" })).toEqual({
    error: "The App ID is a number.",
  });
  expect(
    await addGitHubApp(db, encryptionKey, organizationId, { ...input, privateKey: "nope" }),
  ).toEqual({ error: "The private key is not a PEM private key." });
  const added = await addGitHubApp(db, encryptionKey, organizationId, input);
  if (!("app" in added)) throw new Error(added.error);
  expect(added.app.secrets).not.toContain("BEGIN");
  expect(await addGitHubApp(db, encryptionKey, "other", input)).toEqual({
    error: "GitHub App 424242 is already on this hub.",
  });
});
