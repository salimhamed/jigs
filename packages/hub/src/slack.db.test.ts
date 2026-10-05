import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { factoryStatusPath, type SlackTokenResponse, slackTokenPath } from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { type App, setAssignments } from "./apps.ts";
import { connectDatabase, type HubDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { createTestDatabase, dbTest } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import { createFactoryApi } from "./factory-api.ts";
import { GitHubTokens } from "./github.ts";
import { LinearTokens } from "./linear.ts";
import { MessageWaiters, readMessages } from "./messages.ts";
import { PagerDutyTokens } from "./pagerduty.ts";
import {
  addSlackApp,
  createSlackRoutes,
  slackBotScopes,
  slackCallbackPath,
  slackInstallPath,
  slackWebhookPath,
} from "./slack.ts";

const encryptionKey = randomBytes(32);
const organizationId = "acme";
const publicUrl = new URL("https://hub.example.test");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: HubDatabase;
const waiters = new MessageWaiters();
const servers: Server[] = [];
let hub: string;

interface Workspace {
  id: string;
  name: string;
  botUserId: string;
}

// The fake Slack: codes it handed out for an app and workspace.
const codes = new Map<string, { clientId: string; appId: string; workspace: Workspace }>();
const clientSecrets = new Map<string, string>();
let issued = 0;

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fakeSlack() {
  return express().post("/oauth.v2.access", express.urlencoded(), (request, response) => {
    const form = request.body as Record<string, string>;
    if (clientSecrets.get(form.client_id ?? "") !== form.client_secret) {
      response.json({ ok: false, error: "invalid_client_id" });
      return;
    }
    const granted = codes.get(form.code ?? "");
    codes.delete(form.code ?? "");
    if (!granted || granted.clientId !== form.client_id) {
      response.json({ ok: false, error: "invalid_code" });
      return;
    }
    issued += 1;
    response.json({
      ok: true,
      access_token: `xoxb-${issued}`,
      token_type: "bot",
      scope: slackBotScopes.join(","),
      bot_user_id: granted.workspace.botUserId,
      app_id: granted.appId,
      team: { id: granted.workspace.id, name: granted.workspace.name },
      enterprise: null,
      authed_user: { id: "U0ADMIN" },
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
  const slack = await listen(fakeSlack());
  hub = await listen(
    express()
      .use(
        createSlackRoutes({
          db,
          waiters,
          encryptionKey,
          publicUrl,
          // Stands in for the session: the header names the Organization the caller administers.
          adminOrganization: async (request) => request.get("x-admin-of") ?? null,
          apiUrl: slack,
        }),
      )
      .use(
        createFactoryApi({
          db,
          waiters,
          githubTokens: new GitHubTokens({ db, encryptionKey }),
          linearTokens: new LinearTokens({ db, encryptionKey }),
          pagerDutyTokens: new PagerDutyTokens({ db, encryptionKey }),
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

interface SlackApp {
  app: App;
  clientId: string;
  signingSecret: string;
}

let appCount = 0;
async function newApp(organization = organizationId): Promise<SlackApp> {
  appCount += 1;
  const clientId = `${appCount}.${appCount}`;
  const signingSecret = `signing ${appCount}`;
  clientSecrets.set(clientId, `secret ${appCount}`);
  const added = await addSlackApp(db, encryptionKey, organization, {
    name: `Jigs ${appCount}`,
    appId: `A0${appCount}`,
    clientId,
    clientSecret: `secret ${appCount}`,
    signingSecret,
  });
  if ("error" in added) throw new Error(added.error);
  return { app: added.app, clientId, signingSecret };
}

let workspaceCount = 0;
function newWorkspace(): Workspace {
  workspaceCount += 1;
  return {
    id: `T0${workspaceCount}`,
    name: `Workspace ${workspaceCount}`,
    botUserId: `U0B${workspaceCount}`,
  };
}

let factoryCount = 0;
async function newFactory() {
  factoryCount += 1;
  return addFactory(db, organizationId, `factory ${factoryCount}`);
}

const cookieOf = (response: Response) =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function startInstall(app: App, admin: string | null = app.organizationId) {
  return fetch(`${hub}${slackInstallPath(app.id)}`, {
    redirect: "manual",
    headers: admin ? { "x-admin-of": admin } : {},
  });
}

async function callback(app: App, query: Record<string, string>, cookie: string, admin = true) {
  const response = await fetch(`${hub}${slackCallbackPath(app.id)}?${new URLSearchParams(query)}`, {
    redirect: "manual",
    headers: { cookie, ...(admin ? { "x-admin-of": app.organizationId } : {}) },
  });
  return { status: response.status, location: response.headers.get("location") };
}

/** Install an app the way an admin does: start, approve in Slack, come back. */
async function install(slack: SlackApp, workspace: Workspace, appId = slack.app.externalId) {
  const started = await startInstall(slack.app);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const code = `code-${crypto.randomUUID()}`;
  codes.set(code, { clientId: slack.clientId, appId, workspace });
  return callback(slack.app, { code, state }, cookieOf(started));
}

const messageEvent = (
  slack: SlackApp,
  workspace: Workspace,
  eventId = `Ev${crypto.randomUUID()}`,
) => ({
  token: "verification-token",
  team_id: workspace.id,
  api_app_id: slack.app.externalId,
  event: {
    type: "message",
    channel: "C01",
    channel_type: "channel",
    user: "U0ADA",
    text: "hello",
    ts: "1700000000.000100",
  },
  type: "event_callback",
  event_id: eventId,
  event_time: 1700000000,
});

async function deliver(
  secret: string,
  payload: unknown,
  options: { timestamp?: number; retry?: number; signature?: string } = {},
) {
  const body = JSON.stringify(payload);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature =
    options.signature ??
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return fetch(`${hub}${slackWebhookPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      ...(options.retry === undefined
        ? {}
        : { "x-slack-retry-num": String(options.retry), "x-slack-retry-reason": "http_timeout" }),
    },
    body,
  });
}

const eventNames = async (factoryId: string) =>
  (await readMessages(db, factoryId)).map((message) =>
    message.kind === "event" ? message.event.name : message.kind,
  );

async function requestToken(token: string, body: unknown) {
  const response = await fetch(`${hub}${slackTokenPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "jigs/1.2.3",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const installationsOf = (app: App) =>
  db.select().from(schema.installations).where(eq(schema.installations.appId, app.id));

dbTest("installs an app in a workspace through Slack's OAuth flow", async () => {
  const slack = await newApp();
  const workspace = newWorkspace();
  const started = await startInstall(slack.app);
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get("location") ?? "");
  expect(`${authorize.origin}${authorize.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toEqual({
    client_id: slack.clientId,
    scope: slackBotScopes.join(","),
    redirect_uri: `${publicUrl.origin}${slackCallbackPath(slack.app.id)}`,
    state: expect.stringMatching(/^[\w-]{43}$/),
  });
  expect(started.headers.get("set-cookie")).toMatch(/HttpOnly/i);

  expect(await install(slack, workspace)).toEqual({
    status: 303,
    location: `/apps/${slack.app.id}`,
  });
  const [row] = await installationsOf(slack.app);
  expect(row).toMatchObject({
    externalId: workspace.id,
    account: workspace.name,
    settings: { botUserId: workspace.botUserId },
  });
  expect(row?.secrets).not.toContain("xoxb");

  // Installing again updates the workspace in place.
  await install(slack, { ...workspace, name: "Renamed" });
  expect(await installationsOf(slack.app)).toEqual([
    expect.objectContaining({ externalId: workspace.id, account: "Renamed" }),
  ]);

  // Slack installed some other app with this client ID: the app ID was mistyped.
  expect((await install(slack, newWorkspace(), "A0WRONG")).status).toBe(400);
  expect(await installationsOf(slack.app)).toHaveLength(1);
});

dbTest("refuses a callback whose state is not the admin's own", async () => {
  const slack = await newApp();
  const workspace = newWorkspace();
  expect((await startInstall(slack.app, null)).status).toBe(404);
  expect((await startInstall(slack.app, "other")).status).toBe(404);

  const started = await startInstall(slack.app);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const code = "code-forged";
  codes.set(code, { clientId: slack.clientId, appId: slack.app.externalId, workspace });
  expect((await callback(slack.app, { code, state }, "")).status).toBe(400);
  expect((await callback(slack.app, { code, state: "guess" }, cookieOf(started))).status).toBe(400);
  expect((await callback(slack.app, { code, state }, cookieOf(started), false)).status).toBe(404);
  expect(
    (await callback(slack.app, { error: "access_denied", state }, cookieOf(started))).status,
  ).toBe(400);
  expect((await callback(slack.app, { code: "unknown", state }, cookieOf(started))).status).toBe(
    502,
  );
  expect(await installationsOf(slack.app)).toEqual([]);
});

dbTest("answers Slack's URL verification for any of its apps' signing secrets", async () => {
  const slack = await newApp();
  const challenge = {
    token: "t",
    challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    type: "url_verification",
  };
  const answered = await deliver(slack.signingSecret, challenge);
  expect(answered.status).toBe(200);
  expect(await answered.json()).toEqual({ challenge: challenge.challenge });
  expect((await deliver("not a secret", challenge)).status).toBe(401);
});

dbTest("stores a signed, current event once and sends it only to the app's factories", async () => {
  const slack = await newApp();
  const other = await newApp();
  const workspace = newWorkspace();
  await install(slack, workspace);
  await install(other, workspace);
  const [assigned, unassigned] = [(await newFactory()).factory, (await newFactory()).factory];
  await setAssignments(db, organizationId, slack.app.id, [assigned.id]);
  await setAssignments(db, organizationId, other.app.id, [unassigned.id]);

  const payload = messageEvent(slack, workspace);
  expect((await deliver(slack.signingSecret, payload)).status).toBe(200);
  const [message] = await readMessages(db, assigned.id);
  expect(message).toMatchObject({
    kind: "event",
    event: { provider: "slack", name: "message", payload },
  });
  expect(await eventNames(unassigned.id)).toEqual([]);

  const fresh = () => messageEvent(slack, workspace);
  expect((await deliver(other.signingSecret, fresh())).status).toBe(401);
  expect((await deliver(slack.signingSecret, fresh(), { signature: "v0=00" })).status).toBe(401);
  expect(
    (await deliver(slack.signingSecret, fresh(), { timestamp: Date.now() / 1000 - 6 * 60 })).status,
  ).toBe(401);

  // Slack retries after three seconds without an answer; a retry of a stored event is dropped.
  expect((await deliver(slack.signingSecret, payload, { retry: 1 })).status).toBe(200);
  // A retry of an event the hub never stored is the first it hears of it.
  expect((await deliver(slack.signingSecret, fresh(), { retry: 1 })).status).toBe(200);
  expect(await eventNames(assigned.id)).toEqual(["message", "message"]);

  // Events the hub cannot place get a 200, so Slack does not retry them for ever.
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((await deliver(slack.signingSecret, { ...fresh(), api_app_id: "A0UNKNOWN" })).status).toBe(
    200,
  );
  expect((await deliver(slack.signingSecret, messageEvent(slack, newWorkspace()))).status).toBe(
    200,
  );
  expect(warnings).toHaveBeenCalledTimes(2);
  warnings.mockRestore();
  expect(await eventNames(assigned.id)).toEqual(["message", "message"]);
});

dbTest("issues the bot token of the installation the request names, or the only one", async () => {
  const slack = await newApp();
  const workspace = newWorkspace();
  await install(slack, workspace);
  const { factory, token } = await newFactory();
  await setAssignments(db, organizationId, slack.app.id, [factory.id]);

  const named = await requestToken(token, { appId: slack.app.externalId, team: workspace.id });
  expect(named).toEqual({
    status: 200,
    body: {
      token: expect.stringMatching(/^xoxb-/),
      app: { appId: slack.app.externalId, name: slack.app.name, botUserId: workspace.botUserId },
      team: workspace.id,
    } satisfies SlackTokenResponse,
  });
  expect(await requestToken(token, {})).toEqual(named);
  expect(await requestToken(token, { team: workspace.id })).toEqual(named);
  expect(await requestToken(token, { team: "T0NOWHERE" })).toEqual({
    status: 404,
    body: {
      error: "No installation of a Slack app assigned to this factory matches workspace T0NOWHERE.",
    },
  });
  expect((await requestToken(token, { team: "" })).status).toBe(400);
  expect((await requestToken(token, { appId: 7 })).status).toBe(400);
  expect((await requestToken("nope", {})).status).toBe(401);

  const status = await fetch(`${hub}${factoryStatusPath}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "jigs/1.2.3" },
  });
  expect((await status.json()).apps).toEqual([
    { provider: "slack", name: slack.app.name, installations: [{ account: workspace.name }] },
  ]);
});

dbTest("refuses a token when no installation, or more than one, matches", async () => {
  const [first, second] = [await newApp(), await newApp()];
  const [shared, own] = [newWorkspace(), newWorkspace()];
  const { factory, token } = await newFactory();
  expect(await requestToken(token, {})).toEqual({
    status: 404,
    body: { error: "No Slack app assigned to this factory is installed in a workspace." },
  });
  await install(first, shared);
  await install(second, shared);
  await install(second, own);
  await setAssignments(db, organizationId, first.app.id, [factory.id]);
  await setAssignments(db, organizationId, second.app.id, [factory.id]);

  expect((await requestToken(token, {})).status).toBe(409);
  expect((await requestToken(token, { team: shared.id })).status).toBe(409);
  expect((await requestToken(token, { appId: second.app.externalId })).status).toBe(409);
  expect(
    (await requestToken(token, { appId: second.app.externalId, team: shared.id })).status,
  ).toBe(200);
  expect((await requestToken(token, { team: own.id })).status).toBe(200);
});

dbTest("validates a Slack app and adds it once per hub", async () => {
  const input = {
    name: "Jigs",
    appId: "A0DUP",
    clientId: "1.2",
    clientSecret: "s",
    signingSecret: "w",
  };
  expect(
    await addSlackApp(db, encryptionKey, organizationId, { ...input, signingSecret: "" }),
  ).toEqual({
    error: "Enter the name, app ID, client ID, client secret and signing secret.",
  });
  const added = await addSlackApp(db, encryptionKey, organizationId, input);
  if (!("app" in added)) throw new Error(added.error);
  expect(added.app.secrets).not.toContain("signingSecret");
  expect(await addSlackApp(db, encryptionKey, "other", input)).toEqual({
    error: "The Slack app A0DUP is already on this hub.",
  });
});
