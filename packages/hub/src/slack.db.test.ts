import { createHmac } from "node:crypto";
import {
  factoryStatusPath,
  type SlackTokenResponse,
  slackBotScopes,
  slackTokenPath,
} from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { beforeAll, expect, vi } from "vitest";
import { type App, setAssignments } from "./apps.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import { readMessages } from "./messages.ts";
import {
  addSlackApp,
  createSlackRoutes,
  setSlackScopes,
  slackCallbackPath,
  slackInstallPath,
  slackWebhookPath,
} from "./slack.ts";
import {
  adminFromHeader,
  authorizeUrl,
  finishOAuth,
  organizationId,
  setUpTestHub,
  startOAuth,
  stateCookie,
} from "./test-hub.ts";

const publicUrl = new URL("https://hub.example.test");

const {
  db,
  encryptionKey,
  waiters,
  listen,
  serveHub,
  newFactory,
  eventNames,
  requestToken,
  nameInstallation,
} = setUpTestHub();
let hub: string;

interface Workspace {
  id: string;
  name: string;
  botUserId: string;
}

// The fake Slack: codes it handed out for an app and workspace.
const codes = new Map<
  string,
  { clientId: string; appId: string; workspace: Workspace; scope?: string; expiresIn?: number }
>();
const clientSecrets = new Map<string, string>();
let issued = 0;

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
      scope: granted.scope,
      ...(granted.expiresIn === undefined
        ? {}
        : { expires_in: granted.expiresIn, refresh_token: "xoxe-1" }),
      bot_user_id: granted.workspace.botUserId,
      app_id: granted.appId,
      team: { id: granted.workspace.id, name: granted.workspace.name },
      enterprise: null,
      authed_user: { id: "U0ADMIN" },
    });
  });
}

beforeAll(async () => {
  const slack = await listen(fakeSlack());
  hub = await serveHub({
    routes: createSlackRoutes({
      db,
      waiters,
      encryptionKey,
      publicUrl,
      adminOrganization: adminFromHeader,
      apiUrl: slack,
    }),
  });
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

const startInstall = (app: App, admin: string | null = app.organizationId) =>
  startOAuth(`${hub}${slackInstallPath(app.id)}`, admin);

const callback = (app: App, query: Record<string, string>, cookie: string, admin = true) =>
  finishOAuth(
    `${hub}${slackCallbackPath(app.id)}`,
    query,
    cookie,
    admin ? app.organizationId : null,
  );

/** Install an app the way an admin does: start, approve in Slack, come back. */
async function install(
  slack: SlackApp,
  workspace: Workspace,
  options: { appId?: string; expiresIn?: number } = {},
) {
  const started = await startInstall(slack.app);
  const authorize = authorizeUrl(started).searchParams;
  const state = authorize.get("state") ?? "";
  const code = `code-${crypto.randomUUID()}`;
  codes.set(code, {
    clientId: slack.clientId,
    appId: options.appId ?? slack.app.externalId,
    workspace,
    scope: authorize.get("scope") ?? "",
    expiresIn: options.expiresIn,
  });
  return callback(slack.app, { code, state }, stateCookie(started));
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

const requestSlackToken = (token: string, installationName: string) =>
  requestToken(slackTokenPath, token, { installationName });

const installationsOf = (app: App) =>
  db.select().from(schema.installations).where(eq(schema.installations.appId, app.id));

dbTest("installs an app in a workspace through Slack's OAuth flow", async () => {
  const slack = await newApp();
  const workspace = newWorkspace();
  const started = await startInstall(slack.app);
  expect(started.status).toBe(303);
  const authorize = authorizeUrl(started);
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
    settings: { botUserId: workspace.botUserId, scopes: [...slackBotScopes] },
  });
  expect(row?.secrets).not.toContain("xoxb");

  // Installing again updates the workspace in place.
  await install(slack, { ...workspace, name: "Renamed" });
  expect(await installationsOf(slack.app)).toEqual([
    expect.objectContaining({ externalId: workspace.id, account: "Renamed" }),
  ]);

  // Slack installed some other app with this client ID: the app ID was mistyped.
  expect((await install(slack, newWorkspace(), { appId: "A0WRONG" })).status).toBe(400);
  // Token rotation on: the hub keeps no refresh token, so it refuses a token that expires.
  expect((await install(slack, newWorkspace(), { expiresIn: 43200 })).status).toBe(400);
  expect(await installationsOf(slack.app)).toHaveLength(1);

  // A factory's extra scopes are asked for once an admin adds them.
  const base = slackBotScopes.join(", ");
  const scopes = [...slackBotScopes, "im:history"];
  expect(
    await setSlackScopes(db, organizationId, slack.app.id, `${base}, im:history\nchat:write`),
  ).toEqual({ scopes });
  const asked = authorizeUrl(await startInstall(slack.app));
  expect(asked.searchParams.get("scope")).toBe(scopes.join(","));
  await install(slack, workspace);
  const [reinstalled] = await installationsOf(slack.app);
  expect(reinstalled?.settings).toMatchObject({ scopes });
  expect(await setSlackScopes(db, organizationId, slack.app.id, "chat:write im:history")).toEqual({
    error: `Keep the scopes every factory needs: ${slackBotScopes.filter((s) => s !== "chat:write").join(", ")}.`,
  });
  expect(await setSlackScopes(db, organizationId, slack.app.id, `${base}, Bad Scope`)).toEqual({
    error: "These are not Slack scopes: Bad, Scope.",
  });
  expect(await setSlackScopes(db, "other", slack.app.id, base)).toEqual({
    error: "There is no such Slack app.",
  });
});

dbTest("refuses a callback whose state is not the admin's own", async () => {
  const slack = await newApp();
  const workspace = newWorkspace();
  expect((await startInstall(slack.app, null)).status).toBe(404);
  expect((await startInstall(slack.app, "other")).status).toBe(404);

  const started = await startInstall(slack.app);
  const state = authorizeUrl(started).searchParams.get("state") ?? "";
  const code = "code-forged";
  codes.set(code, { clientId: slack.clientId, appId: slack.app.externalId, workspace });
  expect((await callback(slack.app, { code, state }, "")).status).toBe(400);
  expect((await callback(slack.app, { code, state: "guess" }, stateCookie(started))).status).toBe(
    400,
  );
  expect((await callback(slack.app, { code, state }, stateCookie(started), false)).status).toBe(
    404,
  );
  expect(
    (await callback(slack.app, { error: "access_denied", state }, stateCookie(started))).status,
  ).toBe(400);
  expect((await callback(slack.app, { code: "unknown", state }, stateCookie(started))).status).toBe(
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
    event: { provider: "slack", installationName: null, name: "message", payload },
  });
  await nameInstallation(slack.app.id, workspace.id, "slack-events");
  expect(await readMessages(db, assigned.id)).toMatchObject([
    { event: { installationName: "slack-events" } },
  ]);
  expect(await eventNames(unassigned.id)).toEqual([]);

  const fresh = () => messageEvent(slack, workspace);
  expect((await deliver(other.signingSecret, fresh())).status).toBe(401);
  expect((await deliver(slack.signingSecret, fresh(), { signature: "v0=00" })).status).toBe(401);
  expect(
    (await deliver(slack.signingSecret, fresh(), { timestamp: Date.now() / 1000 - 6 * 60 })).status,
  ).toBe(401);

  // Slack retries after three seconds without an answer; a retry of a stored event is dropped,
  // even when it arrives while the first is still being stored.
  expect((await deliver(slack.signingSecret, payload, { retry: 1 })).status).toBe(200);
  const racing = fresh();
  const raced = await Promise.all([
    deliver(slack.signingSecret, racing),
    deliver(slack.signingSecret, racing, { retry: 1 }),
  ]);
  expect(raced.map((response) => response.status)).toEqual([200, 200]);
  // A retry of an event the hub never stored is the first it hears of it.
  expect((await deliver(slack.signingSecret, fresh(), { retry: 1 })).status).toBe(200);
  expect(await eventNames(assigned.id)).toEqual(["message", "message", "message"]);

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
  expect(await eventNames(assigned.id)).toEqual(["message", "message", "message"]);
});

dbTest("issues the bot token of each named installation of the assigned apps", async () => {
  const [slack, second] = [await newApp(), await newApp()];
  const [workspace, own, unnamed] = [newWorkspace(), newWorkspace(), newWorkspace()];
  await install(slack, workspace);
  await install(second, own);
  await install(second, unnamed);
  await nameInstallation(slack.app.id, workspace.id, "slack-first");
  await nameInstallation(second.app.id, own.id, "slack-second");
  const { factory, token } = await newFactory();
  await setAssignments(db, organizationId, slack.app.id, [factory.id]);
  await setAssignments(db, organizationId, second.app.id, [factory.id]);

  expect(await requestSlackToken(token, "slack-first")).toEqual({
    status: 200,
    body: {
      token: expect.stringMatching(/^xoxb-/),
      scopes: [...slackBotScopes],
      app: { appId: slack.app.externalId, name: slack.app.name, botUserId: workspace.botUserId },
      team: workspace.id,
    } satisfies SlackTokenResponse,
  });
  expect(await requestSlackToken(token, "slack-second")).toMatchObject({
    status: 200,
    body: { app: { name: second.app.name, botUserId: own.botUserId }, team: own.id },
  });
  expect(await requestSlackToken(token, "nowhere")).toEqual({
    status: 404,
    body: { error: "No Slack installation named nowhere is assigned to this factory." },
  });
  expect((await requestSlackToken("nope", "slack-first")).status).toBe(401);

  const status = await fetch(`${hub}${factoryStatusPath}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "jigs/1.2.3" },
  });
  expect((await status.json()).apps).toContainEqual({
    provider: "slack",
    name: slack.app.name,
    installations: [{ account: workspace.name, installationName: "slack-first" }],
  });
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
