import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  factoryStatusPath,
  type LinearTokenResponse,
  linearTokenPath,
} from "@jigs-ai/hub-protocol";
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
import {
  addLinearApp,
  createLinearRoutes,
  LinearTokens,
  linearCallbackPath,
  linearConnectPath,
  linearScopes,
  linearWebhookPath,
} from "./linear.ts";
import { MessageWaiters, readMessages } from "./messages.ts";
import { PagerDutyTokens } from "./pagerduty.ts";

const encryptionKey = randomBytes(32);
const organizationId = "acme";
const publicUrl = new URL("https://hub.example.test");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: HubDatabase;
const waiters = new MessageWaiters();
const servers: Server[] = [];
let hub: string;
let linearTokens: LinearTokens;

interface Workspace {
  id: string;
  name: string;
  urlKey: string;
  userId: string;
}

// The fake Linear: codes it handed out, live access and refresh tokens, and what was posted.
const codes = new Map<string, { clientId: string; workspace: Workspace }>();
const accessTokens = new Map<string, Workspace>();
const refreshTokens = new Map<string, { clientId: string; workspace: Workspace }>();
const activities: { token: string; input: unknown }[] = [];
let issued = 0;
let refreshes = 0;
// Runs once, while the next refresh is out at Linear.
let beforeRefresh: (() => Promise<void>) | null = null;
const clientSecrets = new Map<string, string>();

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function fakeLinear() {
  const tokens = (clientId: string, workspace: Workspace) => {
    issued += 1;
    const access = `lin_oauth_${issued}`;
    const refresh = `lin_refresh_${issued}`;
    accessTokens.set(access, workspace);
    refreshTokens.set(refresh, { clientId, workspace });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 86399,
      scope: "read write app:mentionable app:assignable",
      refresh_token: refresh,
    };
  };
  return express()
    .post("/oauth/token", express.urlencoded(), async (request, response) => {
      const form = request.body as Record<string, string>;
      if (clientSecrets.get(form.client_id ?? "") !== form.client_secret) {
        response.status(401).json({ error: "invalid_client" });
        return;
      }
      if (form.grant_type === "authorization_code") {
        const granted = codes.get(form.code ?? "");
        codes.delete(form.code ?? "");
        const callback = `${publicUrl.origin}/oauth/linear/`;
        if (
          !granted ||
          granted.clientId !== form.client_id ||
          !form.redirect_uri?.startsWith(callback)
        ) {
          response.status(400).json({ error: "invalid_grant" });
          return;
        }
        response.json(tokens(granted.clientId, granted.workspace));
        return;
      }
      const hook = beforeRefresh;
      beforeRefresh = null;
      await hook?.();
      const granted = refreshTokens.get(form.refresh_token ?? "");
      refreshTokens.delete(form.refresh_token ?? "");
      if (form.grant_type !== "refresh_token" || !granted || granted.clientId !== form.client_id) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      refreshes += 1;
      response.json(tokens(granted.clientId, granted.workspace));
    })
    .post("/graphql", express.json(), (request, response) => {
      const token = (request.get("authorization") ?? "").replace(/^Bearer /, "");
      const workspace = accessTokens.get(token);
      if (!workspace) {
        response.status(401).json({ errors: [{ message: "Authentication required" }] });
        return;
      }
      const { query, variables } = request.body as {
        query: string;
        variables?: { input: unknown };
      };
      if (query.includes("agentActivityCreate")) {
        activities.push({ token, input: variables?.input });
        response.json({ data: { agentActivityCreate: { success: true } } });
        return;
      }
      response.json({
        data: {
          viewer: { id: workspace.userId },
          organization: { id: workspace.id, name: workspace.name, urlKey: workspace.urlKey },
        },
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
  const linear = await listen(fakeLinear());
  linearTokens = new LinearTokens({ db, encryptionKey, apiUrl: linear });
  hub = await listen(
    express()
      .use(
        createLinearRoutes({
          db,
          waiters,
          encryptionKey,
          publicUrl,
          linearTokens,
          // Stands in for the session: the header names the Organization the caller administers.
          adminOrganization: async (request) => request.get("x-admin-of") ?? null,
          apiUrl: linear,
        }),
      )
      .use(
        createFactoryApi({
          db,
          waiters,
          githubTokens: new GitHubTokens({ db, encryptionKey }),
          linearTokens,
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

let appCount = 0;
async function newApp(organization = organizationId) {
  appCount += 1;
  const clientId = `client-${appCount}`;
  const webhookSecret = `lin_wh_${appCount}`;
  clientSecrets.set(clientId, `secret ${appCount}`);
  const added = await addLinearApp(db, encryptionKey, organization, {
    name: `Jigs ${appCount}`,
    clientId,
    clientSecret: `secret ${appCount}`,
    webhookSecret,
  });
  if ("error" in added) throw new Error(added.error);
  return { app: added.app, webhookSecret };
}

let workspaceCount = 0;
function newWorkspace(): Workspace {
  workspaceCount += 1;
  return {
    id: crypto.randomUUID(),
    name: `Workspace ${workspaceCount}`,
    urlKey: `ws-${workspaceCount}`,
    userId: crypto.randomUUID(),
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
  return fetch(`${hub}${linearConnectPath(app.id)}`, {
    redirect: "manual",
    headers: admin ? { "x-admin-of": admin } : {},
  });
}

async function callback(app: App, query: Record<string, string>, cookie: string, admin = true) {
  const response = await fetch(
    `${hub}${linearCallbackPath(app.id)}?${new URLSearchParams(query)}`,
    {
      redirect: "manual",
      headers: { cookie, ...(admin ? { "x-admin-of": app.organizationId } : {}) },
    },
  );
  return { status: response.status, location: response.headers.get("location") };
}

/** Connect a workspace the way an admin does: start, approve in Linear, come back. */
async function connect(app: App, workspace: Workspace) {
  const started = await startConnect(app);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const code = `code-${crypto.randomUUID()}`;
  codes.set(code, { clientId: app.externalId, workspace });
  const answered = await callback(app, { code, state }, cookieOf(started));
  expect(answered).toEqual({ status: 303, location: `/apps/${app.id}` });
}

const installationOf = async (app: App, workspace: Workspace) => {
  const [row] = await db
    .select()
    .from(schema.installations)
    .where(eq(schema.installations.appId, app.id));
  expect(row?.externalId).toBe(workspace.id);
  return row;
};

const commentCreated = (workspace: Workspace, at = Date.now()) => ({
  action: "create",
  type: "Comment",
  actor: { id: "user-1", type: "user", name: "Ada" },
  createdAt: new Date(at).toISOString(),
  data: { id: "comment-1", body: "Looks good", issueId: "issue-1", userId: "user-1" },
  url: "https://linear.app/acme/issue/ENG-1#comment-1",
  organizationId: workspace.id,
  webhookId: "webhook-1",
  webhookTimestamp: at,
});

const sessionCreated = (workspace: Workspace, sessionId: string) => ({
  type: "AgentSessionEvent",
  action: "created",
  createdAt: new Date().toISOString(),
  organizationId: workspace.id,
  oauthClientId: "client",
  appUserId: workspace.userId,
  agentSession: { id: sessionId, issue: { id: "issue-1", identifier: "ENG-1" } },
  promptContext: '<issue identifier="ENG-1"></issue>',
  webhookId: "webhook-2",
  webhookTimestamp: Date.now(),
});

async function deliver(
  app: { app: App; webhookSecret: string },
  payload: unknown,
  sign: (body: string) => string | undefined = (body) =>
    createHmac("sha256", app.webhookSecret).update(body).digest("hex"),
) {
  const body = JSON.stringify(payload);
  const signature = sign(body);
  const response = await fetch(`${hub}${linearWebhookPath(app.app.id)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "user-agent": "Linear-Webhook",
      "linear-delivery": crypto.randomUUID(),
      ...(signature ? { "linear-signature": signature } : {}),
    },
    body,
  });
  return response.status;
}

const eventNames = async (factoryId: string) =>
  (await readMessages(db, factoryId)).map((message) =>
    message.kind === "event" ? message.event.name : message.kind,
  );

async function requestToken(token: string, body: unknown) {
  const response = await fetch(`${hub}${linearTokenPath}`, {
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

dbTest("connects a workspace through Linear's OAuth flow as the app", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  const started = await startConnect(linear.app);
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get("location") ?? "");
  expect(`${authorize.origin}${authorize.pathname}`).toBe("https://linear.app/oauth/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toEqual({
    client_id: linear.app.externalId,
    redirect_uri: `${publicUrl.origin}${linearCallbackPath(linear.app.id)}`,
    response_type: "code",
    scope: linearScopes,
    state: expect.stringMatching(/^[\w-]{43}$/),
    actor: "app",
    prompt: "consent",
  });
  expect(started.headers.get("set-cookie")).toMatch(/HttpOnly/i);

  await connect(linear.app, workspace);
  const row = await installationOf(linear.app, workspace);
  expect(row).toMatchObject({
    account: workspace.urlKey,
    settings: { name: workspace.name, userId: workspace.userId },
    failure: null,
  });
  expect(row?.secrets).not.toContain("lin_");

  // Connecting the same workspace again updates it in place.
  await db
    .update(schema.installations)
    .set({ failure: "broken" })
    .where(eq(schema.installations.appId, linear.app.id));
  await connect(linear.app, { ...workspace, name: "Renamed" });
  const rows = await db
    .select()
    .from(schema.installations)
    .where(eq(schema.installations.appId, linear.app.id));
  expect(rows).toEqual([
    expect.objectContaining({
      settings: { name: "Renamed", userId: workspace.userId },
      failure: null,
    }),
  ]);
});

dbTest("refuses a callback whose state is not the admin's own", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  expect((await startConnect(linear.app, null)).status).toBe(404);
  expect((await startConnect(linear.app, "other")).status).toBe(404);

  const started = await startConnect(linear.app);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const code = "code-forged";
  codes.set(code, { clientId: linear.app.externalId, workspace });
  expect((await callback(linear.app, { code, state }, "")).status).toBe(400);
  expect((await callback(linear.app, { code, state: "guess" }, cookieOf(started))).status).toBe(
    400,
  );
  expect((await callback(linear.app, { code, state }, cookieOf(started), false)).status).toBe(404);
  expect(
    (await callback(linear.app, { error: "access_denied", state }, cookieOf(started))).status,
  ).toBe(400);
  expect(
    await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.appId, linear.app.id)),
  ).toEqual([]);
});

dbTest("stores a signed, current event once and sends it only to the app's factories", async () => {
  const linear = await newApp();
  const other = await newApp();
  const workspace = newWorkspace();
  await connect(linear.app, workspace);
  const [assigned, unassigned] = [(await newFactory()).factory, (await newFactory()).factory];
  await setAssignments(db, organizationId, linear.app.id, [assigned.id]);
  await setAssignments(db, organizationId, other.app.id, [unassigned.id]);

  const payload = commentCreated(workspace);
  expect(await deliver(linear, payload)).toBe(200);
  const [message] = await readMessages(db, assigned.id);
  expect(message).toMatchObject({
    kind: "event",
    event: { provider: "linear", name: "Comment", payload },
  });
  expect(await eventNames(unassigned.id)).toEqual([]);

  expect(await deliver(linear, payload, () => undefined)).toBe(401);
  expect(await deliver(linear, payload, () => "00")).toBe(401);
  expect(
    await deliver(linear, payload, (body) =>
      createHmac("sha256", other.webhookSecret).update(body).digest("hex"),
    ),
  ).toBe(401);
  expect(await deliver(linear, commentCreated(workspace, Date.now() - 2 * 60 * 1000))).toBe(401);
  expect(
    await deliver({ ...linear, app: { ...linear.app, id: crypto.randomUUID() } }, payload),
  ).toBe(401);
  expect(await deliver(linear, commentCreated(newWorkspace()))).toBe(202);
  expect(await eventNames(assigned.id)).toEqual(["Comment"]);
});

dbTest("acknowledges a new agent session itself, then sends it on", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  await connect(linear.app, workspace);
  const { factory } = await newFactory();
  await setAssignments(db, organizationId, linear.app.id, [factory.id]);
  const sessionId = crypto.randomUUID();

  expect(await deliver(linear, sessionCreated(workspace, sessionId))).toBe(200);
  await vi.waitFor(() =>
    expect(activities).toContainEqual({
      token: expect.any(String),
      input: {
        agentSessionId: sessionId,
        content: { type: "thought", body: "Received — working on it." },
      },
    }),
  );
  expect(await eventNames(factory.id)).toEqual(["AgentSessionEvent"]);

  // A prompt into an existing session goes on without a reply from the hub.
  const before = activities.length;
  const prompted = { ...sessionCreated(workspace, sessionId), action: "prompted" };
  expect(await deliver(linear, prompted)).toBe(200);
  expect(activities.length).toBe(before);

  // A workspace the hub cannot act in still gets its events through.
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await db
    .update(schema.installations)
    .set({ failure: "revoked" })
    .where(eq(schema.installations.appId, linear.app.id));
  expect(await deliver(linear, sessionCreated(workspace, crypto.randomUUID()))).toBe(200);
  await vi.waitFor(() => expect(errors).toHaveBeenCalled());
  errors.mockRestore();
  expect(activities.length).toBe(before);
  expect(await eventNames(factory.id)).toEqual([
    "AgentSessionEvent",
    "AgentSessionEvent",
    "AgentSessionEvent",
  ]);
});

dbTest("leaves a new agent session to Linear when no factory hears of it", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  await connect(linear.app, workspace);
  const before = activities.length;
  expect(await deliver(linear, sessionCreated(workspace, crypto.randomUUID()))).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(activities.length).toBe(before);
});

dbTest("issues the assigned app's workspace token by id or URL key, or the only one", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  await connect(linear.app, workspace);
  const { factory, token } = await newFactory();
  await setAssignments(db, organizationId, linear.app.id, [factory.id]);

  const first = await requestToken(token, { organization: workspace.id });
  expect(first.status).toBe(200);
  const body = first.body as LinearTokenResponse;
  expect(body).toEqual({
    token: expect.stringMatching(/^lin_oauth_/),
    expiresAt: expect.any(String),
    app: { name: linear.app.name, userId: workspace.userId },
  });
  expect(await requestToken(token, { organization: workspace.urlKey.toUpperCase() })).toEqual(
    first,
  );
  expect(await requestToken(token, {})).toEqual(first);

  expect(await requestToken(token, { organization: "nowhere" })).toEqual({
    status: 404,
    body: { error: "No Linear app assigned to this factory is connected to nowhere." },
  });
  expect((await requestToken(token, { organization: "" })).status).toBe(400);
  expect((await requestToken(token, { organization: 7 })).status).toBe(400);
  expect((await requestToken("nope", {})).status).toBe(401);

  const status = await fetch(`${hub}${factoryStatusPath}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "jigs/1.2.3" },
  });
  expect((await status.json()).apps).toEqual([
    { provider: "linear", name: linear.app.name, installations: [{ account: workspace.urlKey }] },
  ]);
});

dbTest("refuses a token when no workspace, or more than one, matches", async () => {
  const [first, second] = [await newApp(), await newApp()];
  const [shared, own] = [newWorkspace(), newWorkspace()];
  const { factory, token } = await newFactory();
  expect(await requestToken(token, {})).toEqual({
    status: 404,
    body: { error: "No Linear app assigned to this factory is connected to a Linear workspace." },
  });
  await connect(first.app, shared);
  await connect(second.app, shared);
  await connect(second.app, own);
  await setAssignments(db, organizationId, first.app.id, [factory.id]);
  await setAssignments(db, organizationId, second.app.id, [factory.id]);

  const both = [`${first.app.name} (${shared.urlKey})`, `${second.app.name} (${shared.urlKey})`];
  expect(await requestToken(token, { organization: shared.urlKey })).toEqual({
    status: 409,
    body: {
      error: `More than one Linear app assigned to this factory is connected to ${shared.urlKey}: ${both.sort().join(", ")}.`,
    },
  });
  expect((await requestToken(token, {})).status).toBe(409);
  expect((await requestToken(token, { organization: own.id })).status).toBe(200);
});

dbTest("refreshes a token near expiry once, and stops on a refused refresh", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  await connect(linear.app, workspace);
  const { factory } = await newFactory();
  await setAssignments(db, organizationId, linear.app.id, [factory.id]);
  const current = await linearTokens.issue(factory.id, undefined);
  if (!("token" in current)) throw new Error(current.error);

  const nearExpiry = Date.parse(current.token.expiresAt) - 4 * 60 * 1000;
  const before = refreshes;
  const [one, two] = await Promise.all([
    linearTokens.issue(factory.id, undefined, nearExpiry),
    linearTokens.issue(factory.id, undefined, nearExpiry),
  ]);
  expect(refreshes - before).toBe(1);
  expect(one).toEqual(two);
  if (!("token" in one)) throw new Error(one.error);
  expect(one.token.token).not.toBe(current.token.token);
  expect(Date.parse(one.token.expiresAt)).toBeGreaterThan(nearExpiry + 60 * 60 * 1000);
  expect(await linearTokens.issue(factory.id, undefined, nearExpiry)).toEqual(one);
  expect(refreshes - before).toBe(1);

  // Linear refuses a refresh token it no longer knows, as when the app is revoked.
  refreshTokens.clear();
  const later = Date.parse(one.token.expiresAt) - 60 * 1000;
  const refused = await linearTokens.issue(factory.id, undefined, later);
  expect(refused).toEqual({
    status: 503,
    error: `Connect ${workspace.urlKey} to ${linear.app.name} again on the hub: Linear refused to refresh the token (400).`,
  });
  expect((await installationOf(linear.app, workspace))?.failure).toBe(
    "Linear refused to refresh the token (400).",
  );
  const issuedBefore = issued;
  expect(await linearTokens.issue(factory.id, undefined, later)).toEqual(refused);
  expect(issued).toBe(issuedBefore);

  await connect(linear.app, workspace);
  const reconnected = await linearTokens.issue(factory.id, undefined);
  if (!("token" in reconnected)) throw new Error(reconnected.error);

  // A reconnect that lands while a refused refresh is out keeps its own tokens.
  refreshTokens.clear();
  beforeRefresh = () => connect(linear.app, workspace);
  const racing = Date.parse(reconnected.token.expiresAt) - 60 * 1000;
  expect(await linearTokens.issue(factory.id, undefined, racing)).toMatchObject({ status: 503 });
  expect((await installationOf(linear.app, workspace))?.failure).toBeNull();
  expect("token" in (await linearTokens.issue(factory.id, undefined))).toBe(true);
});

dbTest("validates a Linear app and adds it once per hub", async () => {
  const input = { name: "Jigs", clientId: "dup", clientSecret: "s", webhookSecret: "w" };
  expect(
    await addLinearApp(db, encryptionKey, organizationId, { ...input, clientSecret: "" }),
  ).toEqual({ error: "Enter the name, client ID, client secret and webhook signing secret." });
  const added = await addLinearApp(db, encryptionKey, organizationId, input);
  if (!("app" in added)) throw new Error(added.error);
  expect(added.app.secrets).not.toContain("webhookSecret");
  expect(await addLinearApp(db, encryptionKey, "other", input)).toEqual({
    error: "The Linear app with client ID dup is already on this hub.",
  });
});
