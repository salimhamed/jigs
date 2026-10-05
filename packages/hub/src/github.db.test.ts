import { createHmac, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type GitHubTokenResponse, githubTokenPath } from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, expect } from "vitest";
import { type App, setAssignments } from "./apps.ts";
import { connectDatabase, type HubDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { createTestDatabase, dbTest } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import { createFactoryApi } from "./factory-api.ts";
import {
  addGitHubApp,
  createGitHubRoutes,
  type GitHubAppSettings,
  GitHubTokens,
  githubInstallUrl,
  githubSetupPath,
  githubWebhookPath,
} from "./github.ts";
import { LinearTokens } from "./linear.ts";
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
// The fake GitHub's bot users' ids, by login, and the installation tokens it minted.
const githubBots = new Map<string, number>();
const minted: { installationId: string; token: string }[] = [];
let botLookups = 0;
const tokenLifetimeMs = 60 * 60 * 1000;
let githubTokens: GitHubTokens;

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// GitHub's installation endpoints for an App, answering only an App JWT signed with its key.
function fakeGitHub() {
  const appIdOf = (authorization: string | undefined) => {
    const [header = "", payload = "", signature = ""] = (authorization ?? "")
      .replace(/^Bearer /, "")
      .split(".");
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature, "base64url");
    return verified ? String(JSON.parse(Buffer.from(payload, "base64url").toString()).iss) : null;
  };
  const body = (id: string, installation: { appId: string; login: string }) => ({
    id: Number(id),
    account: { login: installation.login, id: 1, type: "Organization" },
    app_id: Number(installation.appId),
    target_type: "Organization",
  });
  return express()
    .get("/app/installations", (request, response) => {
      const appId = appIdOf(request.get("authorization"));
      if (!appId) {
        response.status(401).json({ message: "A JSON web token could not be decoded" });
        return;
      }
      response.json(
        [...githubInstallations]
          .filter(([, installation]) => installation.appId === appId)
          .map(([id, installation]) => body(id, installation)),
      );
    })
    .get("/app/installations/:id", (request, response) => {
      const appId = appIdOf(request.get("authorization"));
      if (!appId) {
        response.status(401).json({ message: "A JSON web token could not be decoded" });
        return;
      }
      const installation = githubInstallations.get(request.params.id);
      if (installation?.appId !== appId) {
        response.status(404).json({ message: "Not Found" });
        return;
      }
      response.json(body(request.params.id, installation));
    })
    .post("/app/installations/:id/access_tokens", (request, response) => {
      const appId = appIdOf(request.get("authorization"));
      if (!appId || githubInstallations.get(request.params.id)?.appId !== appId) {
        response.status(404).json({ message: "Not Found" });
        return;
      }
      const token = `ghs_${minted.length + 1}`;
      minted.push({ installationId: request.params.id, token });
      response.status(201).json({
        token,
        expires_at: new Date(Date.now() + tokenLifetimeMs).toISOString(),
        permissions: { contents: "write" },
        repository_selection: "all",
      });
    })
    .get("/users/:login", (request, response) => {
      const authorized = minted.some(
        ({ token }) => request.get("authorization") === `Bearer ${token}`,
      );
      const id = githubBots.get(request.params.login);
      if (!authorized || id === undefined) {
        response.status(404).json({ message: "Not Found" });
        return;
      }
      botLookups += 1;
      response.json({ login: request.params.login, id, type: "Bot" });
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
  githubTokens = new GitHubTokens({ db, encryptionKey, apiUrl: github });
  hub = await listen(
    express()
      .use(createGitHubRoutes({ db, waiters, encryptionKey, apiUrl: github }))
      .use(
        createFactoryApi({
          db,
          waiters,
          githubTokens,
          linearTokens: new LinearTokens({ db, encryptionKey }),
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
async function newApp(organization = organizationId) {
  appCount += 1;
  const webhookSecret = `secret ${appCount}`;
  const added = await addGitHubApp(
    db,
    encryptionKey,
    organization,
    {
      appId: String(1000 + appCount),
      slug: `jigs-${appCount}`,
      clientId: `Iv1.${appCount}`,
      clientSecret: "client secret",
      webhookSecret,
      privateKey: pem,
    },
    github,
  );
  if ("error" in added) throw new Error(added.error);
  githubBots.set(`${added.app.name}[bot]`, 40000 + appCount);
  return { app: added.app, webhookSecret };
}

let factoryCount = 0;
async function newFactoryWithToken(organization = organizationId) {
  factoryCount += 1;
  return addFactory(db, organization, `factory ${factoryCount}`);
}
const newFactory = async (organization = organizationId) =>
  (await newFactoryWithToken(organization)).factory;

let installationCount = 0;
async function installed(app: App, login = "acme") {
  installationCount += 1;
  const id = String(5000 + installationCount);
  githubInstallations.set(id, { appId: app.externalId, login });
  await db.insert(schema.installations).values({ appId: app.id, externalId: id, account: login });
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

async function setup(app: App | string, query: Record<string, string>) {
  const id = typeof app === "string" ? app : app.id;
  const response = await fetch(`${hub}${githubSetupPath(id)}?${new URLSearchParams(query)}`, {
    redirect: "manual",
  });
  return { status: response.status, location: response.headers.get("location") };
}

dbTest("records an installation GitHub confirms is the App's", async () => {
  const github = await newApp();
  const other = await newApp();
  expect(githubInstallUrl(github.app)).toBe(
    `https://github.com/apps/${github.app.name}/installations/new`,
  );
  githubInstallations.set("31", { appId: github.app.externalId, login: "acme-corp" });
  githubInstallations.set("32", { appId: other.app.externalId, login: "elsewhere" });

  expect(await setup(github.app, { installation_id: "32", setup_action: "install" })).toMatchObject(
    {
      status: 400,
    },
  );
  expect(await setup(github.app, { installation_id: "31", setup_action: "install" })).toEqual({
    status: 303,
    location: `/apps/${github.app.id}`,
  });
  githubInstallations.set("31", { appId: github.app.externalId, login: "acme-renamed" });
  expect(await setup(github.app, { installation_id: "31", setup_action: "update" })).toEqual({
    status: 303,
    location: `/apps/${github.app.id}`,
  });
  const recorded = await db
    .select({ externalId: schema.installations.externalId, account: schema.installations.account })
    .from(schema.installations)
    .where(eq(schema.installations.appId, github.app.id));
  expect(recorded).toEqual([{ externalId: "31", account: "acme-renamed" }]);

  for (const bad of [crypto.randomUUID(), "nonsense"]) {
    expect(await setup(bad, { installation_id: "31" })).toMatchObject({ status: 400 });
  }
  expect(await setup(github.app, {})).toMatchObject({ status: 400 });
});

dbTest("learns installations the hub missed, when added and when an event names one", async () => {
  const appId = "777001";
  githubInstallations.set("61", { appId, login: "early" });
  const added = await addGitHubApp(
    db,
    encryptionKey,
    organizationId,
    {
      appId,
      slug: "jigs-early",
      clientId: "Iv1.early",
      clientSecret: "s",
      webhookSecret: "early secret",
      privateKey: pem,
    },
    github,
  );
  if (!("app" in added)) throw new Error(added.error);
  const app = { app: added.app, webhookSecret: "early secret" };
  const factory = await newFactory();
  await setAssignments(db, organizationId, app.app.id, [factory.id]);
  expect(await deliver(app, "issues", issueOpened(61))).toBe(200);

  githubInstallations.set("62", { appId, login: "missed" });
  expect(await deliver(app, "issues", issueOpened(62))).toBe(200);
  const known = await db
    .select({ externalId: schema.installations.externalId })
    .from(schema.installations)
    .where(eq(schema.installations.appId, app.app.id));
  expect(known.map((row) => row.externalId).sort()).toEqual(["61", "62"]);
  expect(await eventNames(factory.id)).toEqual(["issues", "issues"]);
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
  const add = (organization: string, changes: Partial<typeof input> = {}) =>
    addGitHubApp(db, encryptionKey, organization, { ...input, ...changes }, github);
  expect(await add(organizationId, { appId: "x" })).toEqual({
    error: "The App ID is a number.",
  });
  expect(await add(organizationId, { privateKey: "nope" })).toEqual({
    error: "The private key is not a PEM private key.",
  });
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  expect(await add(organizationId, { privateKey: otherKey })).toEqual({
    error: "GitHub refused App 424242 with this private key (401).",
  });
  const added = await add(organizationId);
  if (!("app" in added)) throw new Error(added.error);
  expect(added.app.secrets).not.toContain("BEGIN");
  expect(await add("other")).toEqual({
    error: "GitHub App 424242 is already on this hub.",
  });
});

async function requestToken(token: string, owner: unknown) {
  const response = await fetch(`${hub}${githubTokenPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "jigs/1.2.3",
      "content-type": "application/json",
    },
    body: JSON.stringify({ owner }),
  });
  return { status: response.status, body: await response.json() };
}

dbTest(
  "issues a fresh installation token of the assigned App for an owner on every request",
  async () => {
    const github = await newApp();
    const { factory, token } = await newFactoryWithToken();
    await setAssignments(db, organizationId, github.app.id, [factory.id]);
    const installationId = String(await installed(github.app, "Acme-Corp"));
    const before = { minted: minted.length, lookups: botLookups };

    const first = await requestToken(token, "acme-corp");
    expect(first.status).toBe(200);
    const issued = first.body as GitHubTokenResponse;
    expect(issued).toEqual({
      token: minted.at(-1)?.token,
      expiresAt: expect.any(String),
      app: { slug: github.app.name, botUserId: githubBots.get(`${github.app.name}[bot]`) },
    });
    expect(minted.at(-1)?.installationId).toBe(installationId);
    expect(minted.length - before.minted).toBe(1);

    const stored = await db.query.apps.findFirst({ where: eq(schema.apps.id, github.app.id) });
    expect(stored?.settings).toEqual({
      clientId: expect.any(String),
      botUserId: issued.app.botUserId,
    } satisfies GitHubAppSettings);

    // The factory asks again for a longer-lived token, or after GitHub rejected one, so every
    // request mints anew; the bot's id is not looked up again.
    const again = await requestToken(token, "ACME-CORP");
    expect(again).toEqual({
      status: 200,
      body: { ...issued, token: minted.at(-1)?.token, expiresAt: expect.any(String) },
    });
    expect((again.body as GitHubTokenResponse).token).not.toBe(issued.token);
    expect(minted.length - before.minted).toBe(2);
    expect(botLookups - before.lookups).toBe(1);
  },
);

dbTest(
  "refuses a token for an owner no assigned App, or more than one, is installed on",
  async () => {
    const [first, second, unassigned] = [await newApp(), await newApp(), await newApp()];
    const { factory, token } = await newFactoryWithToken();
    await setAssignments(db, organizationId, first.app.id, [factory.id]);
    await setAssignments(db, organizationId, second.app.id, [factory.id]);
    await installed(first.app, "shared");
    await installed(second.app, "shared");
    await installed(unassigned.app, "elsewhere");
    const before = minted.length;

    expect(await requestToken(token, "nobody")).toEqual({
      status: 404,
      body: { error: "No GitHub App assigned to this factory is installed on nobody." },
    });
    expect((await requestToken(token, "elsewhere")).status).toBe(404);
    expect(await requestToken(token, "shared")).toEqual({
      status: 409,
      body: {
        error: `More than one GitHub App assigned to this factory is installed on shared: ${[first.app.name, second.app.name].sort().join(", ")}.`,
      },
    });
    expect((await requestToken(token, "")).status).toBe(400);
    expect((await requestToken(token, 7)).status).toBe(400);
    expect((await requestToken("nope", "shared")).status).toBe(401);
    expect(minted.length).toBe(before);
  },
);
