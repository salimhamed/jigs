import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { type GitHubTokenResponse, githubTokenPath } from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { beforeAll, expect } from "vitest";
import { type App, assignApp, renameApp, setInstallationName } from "./apps.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import {
  addGitHubApp,
  createGitHubRoutes,
  type GitHubAppSettings,
  githubInstallUrl,
  githubSetupPath,
  githubWebhookPath,
} from "./github.ts";
import { readMessages } from "./messages.ts";
import { organizationId, setUpTestHub } from "./test-hub.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const { db, encryptionKey, waiters, listen, serveHub, newFactory, eventNames, requestToken } =
  setUpTestHub();
let hub: string;
let github: string;
// The fake GitHub's installations, by installation id: the App ID and account.
const githubInstallations = new Map<string, { appId: string; login: string }>();
// The fake GitHub's bot users' ids, by login, and the installation tokens it minted.
const githubBots = new Map<string, number>();
const slugOf = (app: App) => (app.settings as GitHubAppSettings).slug;
const minted: { installationId: string; token: string }[] = [];
let botLookups = 0;
const tokenLifetimeMs = 60 * 60 * 1000;

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
  github = await listen(fakeGitHub());
  hub = await serveHub({
    routes: createGitHubRoutes({ db, waiters, encryptionKey, apiUrl: github }),
    apiUrls: { github },
  });
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
      name: `Jigs ${appCount}`,
      appId: String(1000 + appCount),
      slug: `jigs-${appCount}`,
      clientId: `Iv1.${appCount}`,
      clientSecret: "client secret",
      webhookSecret,
      privateKey: pem,
    },
    { apiUrl: github },
  );
  if ("error" in added) throw new Error(added.error);
  githubBots.set(`${slugOf(added.app)}[bot]`, 40000 + appCount);
  return { app: added.app, webhookSecret };
}

let installationCount = 0;
async function installed(app: App, login = "acme", installationName?: string) {
  installationCount += 1;
  const id = String(5000 + installationCount);
  githubInstallations.set(id, { appId: app.externalId, login });
  await db.insert(schema.installations).values({
    appId: app.id,
    organizationId: app.organizationId,
    externalId: id,
    account: login,
    installationName,
  });
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
    app_slug: slugOf(app),
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

const providerEventsOf = (app: App) =>
  db.select().from(schema.providerEvents).where(eq(schema.providerEvents.appId, app.id));

dbTest("stores a signed event once and sends it only to the app's factories", async () => {
  const github = await newApp();
  const otherApp = await newApp();
  const [assigned, alsoAssigned, unassigned] = [
    (await newFactory()).factory,
    (await newFactory()).factory,
    (await newFactory()).factory,
  ];
  await assignApp(db, organizationId, assigned.id, github.app.id);
  await assignApp(db, organizationId, alsoAssigned.id, github.app.id);
  await assignApp(db, organizationId, unassigned.id, otherApp.app.id);
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
  expect(message).toMatchObject({
    kind: "event",
    event: { id: stored?.id, installationName: null, name: "issues" },
  });
  expect(await eventNames(alsoAssigned.id)).toEqual(["issues"]);
  expect(await eventNames(unassigned.id)).toEqual([]);

  // An installation named after its events arrived delivers them with the name.
  await db
    .update(schema.installations)
    .set({ installationName: "gh-events" })
    .where(eq(schema.installations.externalId, String(installationId)));
  expect(await readMessages(db, assigned.id)).toMatchObject([
    { event: { installationName: "gh-events" } },
  ]);
});

dbTest("answers ping without storing it", async () => {
  const github = await newApp();
  const { factory } = await newFactory();
  await assignApp(db, organizationId, factory.id, github.app.id);
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
  const { factory } = await newFactory();
  await assignApp(db, organizationId, factory.id, github.app.id);
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
  const { factory } = await newFactory();
  await assignApp(db, organizationId, factory.id, github.app.id);
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
  // The installation is gone, so none of its events carries a name any more.
  expect(
    (await readMessages(db, factory.id)).map(
      (message) => message.kind === "event" && message.event.installationName,
    ),
  ).toEqual([null, null, null]);
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
    `https://github.com/apps/${slugOf(github.app)}/installations/new`,
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
      name: "Early",
      appId,
      slug: "jigs-early",
      clientId: "Iv1.early",
      clientSecret: "s",
      webhookSecret: "early secret",
      privateKey: pem,
    },
    { apiUrl: github },
  );
  if (!("app" in added)) throw new Error(added.error);
  const app = { app: added.app, webhookSecret: "early secret" };
  const { factory } = await newFactory();
  await assignApp(db, organizationId, factory.id, app.app.id);
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

dbTest("names installations uniquely within an Organization", async () => {
  const [first, second, theirs] = [await newApp(), await newApp(), await newApp("other")];
  await installed(first.app, "acme");
  await installed(second.app, "widgets");
  await installed(theirs.app, "other");
  const [acme, widgets, other] = await Promise.all(
    [first, second, theirs].map(async ({ app }) => {
      const [row] = await db
        .select()
        .from(schema.installations)
        .where(eq(schema.installations.appId, app.id));
      if (!row) throw new Error("expected an installation");
      expect(row.installationName).toBeNull();
      return row;
    }),
  );
  if (!acme || !widgets || !other) throw new Error("expected installations");
  const name = (app: App, installationId: string, installationName: string, org = organizationId) =>
    setInstallationName(db, org, app.id, installationId, installationName);

  expect(await name(first.app, acme.id, "github-acme")).toEqual({
    installationName: "github-acme",
  });
  for (const bad of ["", "GitHub", "1github", "-github", "github_acme", "github acme"]) {
    expect(await name(first.app, acme.id, bad)).toEqual({
      error:
        "An installation name is lowercase letters, digits and hyphens, starting with a letter.",
    });
  }
  expect(await name(second.app, widgets.id, "github-acme")).toEqual({
    error: "Another installation is already named github-acme.",
  });
  // Another Organization's names are its own.
  expect(await name(theirs.app, other.id, "github-acme", "other")).toEqual({
    installationName: "github-acme",
  });
  expect(await name(theirs.app, other.id, "github-other")).toEqual({
    error: "There is no such installation.",
  });
  expect(await name(second.app, acme.id, "github-widgets")).toEqual({
    error: "There is no such installation.",
  });
  expect(await name(first.app, "not-a-uuid", "github-widgets")).toEqual({
    error: "There is no such installation.",
  });
  // Renaming keeps the row and frees the old name.
  expect(await name(first.app, acme.id, "github-acme-2")).toEqual({
    installationName: "github-acme-2",
  });
  expect(await name(second.app, widgets.id, "github-acme")).toEqual({
    installationName: "github-acme",
  });
});

dbTest("validates a GitHub App before adding it, once per hub", async () => {
  const input = {
    name: "Acme",
    appId: "424242",
    slug: "jigs-acme",
    clientId: "Iv1.abc",
    clientSecret: "s",
    webhookSecret: "w",
    privateKey: pem,
  };
  const add = (organization: string, changes: Partial<typeof input> = {}) =>
    addGitHubApp(
      db,
      encryptionKey,
      organization,
      { ...input, ...changes },
      {
        apiUrl: github,
      },
    );
  expect(await add(organizationId, { name: "" })).toEqual({ error: "Name the app." });
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
    error: "GitHub refused app 424242 with this private key (401).",
  });
  const added = await add(organizationId);
  if (!("app" in added)) throw new Error(added.error);
  expect(added.app.secrets).not.toContain("BEGIN");
  expect(await add("other")).toEqual({
    error: "GitHub App 424242 is already on this hub.",
  });
});

const requestGitHubToken = (token: string, installationName: unknown) =>
  requestToken(githubTokenPath, token, { installationName });

dbTest(
  "issues a fresh token of each named installation of the assigned Apps on every request",
  async () => {
    const [github, second] = [await newApp(), await newApp()];
    const { factory, token } = await newFactory();
    await assignApp(db, organizationId, factory.id, github.app.id);
    await assignApp(db, organizationId, factory.id, second.app.id);
    const installationId = String(await installed(github.app, "Acme-Corp", "gh-acme-corp"));
    const widgetsId = String(await installed(github.app, "widgets", "gh-widgets"));
    const secondId = String(await installed(second.app, "acme-labs", "gh-acme-labs"));
    const before = { minted: minted.length, lookups: botLookups };

    const first = await requestGitHubToken(token, "gh-acme-corp");
    expect(first.status).toBe(200);
    const issued = first.body as GitHubTokenResponse;
    expect(issued).toEqual({
      token: minted.at(-1)?.token,
      expiresAt: expect.any(String),
      account: "Acme-Corp",
      app: { slug: slugOf(github.app), botUserId: githubBots.get(`${slugOf(github.app)}[bot]`) },
    });
    expect(minted.at(-1)?.installationId).toBe(installationId);
    expect(minted.length - before.minted).toBe(1);

    const stored = await db.query.apps.findFirst({ where: eq(schema.apps.id, github.app.id) });
    expect(stored?.settings).toEqual({
      slug: slugOf(github.app),
      clientId: expect.any(String),
      botUserId: issued.app.botUserId,
    } satisfies GitHubAppSettings);

    // The factory asks again for a longer-lived token, or after GitHub rejected one, so every
    // request mints anew; the bot's id is not looked up again. A new name leaves the slug alone.
    expect(await renameApp(db, organizationId, github.app.id, "Acme bot")).toEqual({
      name: "Acme bot",
    });
    const again = await requestGitHubToken(token, "gh-acme-corp");
    expect(again).toEqual({
      status: 200,
      body: { ...issued, token: minted.at(-1)?.token, expiresAt: expect.any(String) },
    });
    expect((again.body as GitHubTokenResponse).token).not.toBe(issued.token);
    expect(minted.length - before.minted).toBe(2);
    expect(botLookups - before.lookups).toBe(1);

    expect((await requestGitHubToken(token, "gh-widgets")).body).toMatchObject({
      account: "widgets",
      app: { slug: slugOf(github.app) },
    });
    expect(minted.at(-1)?.installationId).toBe(widgetsId);
    expect((await requestGitHubToken(token, "gh-acme-labs")).body).toMatchObject({
      account: "acme-labs",
      app: { slug: slugOf(second.app) },
    });
    expect(minted.at(-1)?.installationId).toBe(secondId);
  },
);

dbTest(
  "refuses a token unless it names an installation of an App assigned to the factory",
  async () => {
    const [assigned, unassigned, theirs] = [await newApp(), await newApp(), await newApp("other")];
    const { factory, token } = await newFactory();
    await assignApp(db, organizationId, factory.id, assigned.app.id);
    await installed(assigned.app, "unnamed");
    await installed(unassigned.app, "elsewhere", "gh-elsewhere");
    await installed(theirs.app, "theirs", "gh-theirs");
    // Assignments never cross Organizations; this one stands in for a bug that made one.
    await db.insert(schema.assignments).values({ appId: theirs.app.id, factoryId: factory.id });
    const before = minted.length;

    expect(await requestGitHubToken(token, "gh-nobody")).toEqual({
      status: 404,
      body: { error: "No GitHub installation named gh-nobody is assigned to this factory." },
    });
    expect((await requestGitHubToken(token, "unnamed")).status).toBe(404);
    expect((await requestGitHubToken(token, "gh-elsewhere")).status).toBe(404);
    expect((await requestGitHubToken(token, "gh-theirs")).status).toBe(404);
    for (const bad of ["", 7, undefined]) {
      expect(await requestGitHubToken(token, bad)).toEqual({
        status: 400,
        body: { error: "installationName must name an installation." },
      });
    }
    expect((await requestGitHubToken("nope", "gh-theirs")).status).toBe(401);
    expect(minted.length).toBe(before);
  },
);
