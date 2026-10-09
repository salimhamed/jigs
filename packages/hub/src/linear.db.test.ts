import { createHmac } from "node:crypto";
import {
  factoryStatusPath,
  type LinearTokenResponse,
  linearTokenPath,
} from "@jigs-ai/hub-protocol";
import { eq } from "drizzle-orm";
import express from "express";
import { beforeAll, expect, vi } from "vitest";
import { type App, assignApp } from "./apps.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import {
  addLinearApp,
  createLinearRoutes,
  LinearTokens,
  linearCallbackPath,
  linearConnectPath,
  linearScopes,
  linearWebhookPath,
} from "./linear.ts";
import { readMessages } from "./messages.ts";
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
  const linear = await listen(fakeLinear());
  linearTokens = new LinearTokens({ db, encryptionKey, apiUrl: linear });
  hub = await serveHub({
    routes: createLinearRoutes({
      db,
      waiters,
      encryptionKey,
      publicUrl,
      linearTokens,
      adminOrganization: adminFromHeader,
      apiUrl: linear,
    }),
    linearTokens,
  });
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

const startConnect = (app: App, admin: string | null = app.organizationId) =>
  startOAuth(`${hub}${linearConnectPath(app.id)}`, admin);

const callback = (app: App, query: Record<string, string>, cookie: string, admin = true) =>
  finishOAuth(
    `${hub}${linearCallbackPath(app.id)}`,
    query,
    cookie,
    admin ? app.organizationId : null,
  );

/** Connect a workspace the way an admin does: start, approve in Linear, come back. */
async function connect(app: App, workspace: Workspace) {
  const started = await startConnect(app);
  const state = authorizeUrl(started).searchParams.get("state") ?? "";
  const code = `code-${crypto.randomUUID()}`;
  codes.set(code, { clientId: app.externalId, workspace });
  const answered = await callback(app, { code, state }, stateCookie(started));
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
  agentSession: {
    id: sessionId,
    issue: { id: "issue-1", identifier: "ENG-1" },
    creator: { id: "user-1", name: "Ada" },
  },
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

const requestLinearToken = (token: string, installationName: string) =>
  requestToken(linearTokenPath, token, { installationName });

dbTest("connects a workspace through Linear's OAuth flow as the app", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  const started = await startConnect(linear.app);
  expect(started.status).toBe(303);
  const authorize = authorizeUrl(started);
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
  const state = authorizeUrl(started).searchParams.get("state") ?? "";
  const code = "code-forged";
  codes.set(code, { clientId: linear.app.externalId, workspace });
  expect((await callback(linear.app, { code, state }, "")).status).toBe(400);
  expect((await callback(linear.app, { code, state: "guess" }, stateCookie(started))).status).toBe(
    400,
  );
  expect((await callback(linear.app, { code, state }, stateCookie(started), false)).status).toBe(
    404,
  );
  expect(
    (await callback(linear.app, { error: "access_denied", state }, stateCookie(started))).status,
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
  await assignApp(db, organizationId, assigned.id, linear.app.id);
  await assignApp(db, organizationId, unassigned.id, other.app.id);

  const payload = commentCreated(workspace);
  expect(await deliver(linear, payload)).toBe(200);
  await nameInstallation(linear.app.id, workspace.id, "lin-events");
  const [message] = await readMessages(db, assigned.id);
  expect(message).toMatchObject({
    kind: "event",
    event: { provider: "linear", installationName: "lin-events", name: "Comment", payload },
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
  await assignApp(db, organizationId, factory.id, linear.app.id);
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

  // A session in another workspace of the app is acknowledged with that workspace's token.
  const otherWorkspace = newWorkspace();
  await connect(linear.app, otherWorkspace);
  await nameInstallation(linear.app.id, otherWorkspace.id, "lin-acknowledged");
  const otherSession = crypto.randomUUID();
  expect(await deliver(linear, sessionCreated(otherWorkspace, otherSession))).toBe(200);
  const otherToken = await linearTokens.issue(factory.id, "lin-acknowledged");
  if (!("token" in otherToken)) throw new Error(otherToken.error);
  await vi.waitFor(() =>
    expect(activities).toContainEqual({
      token: otherToken.token.token,
      input: expect.objectContaining({ agentSessionId: otherSession }),
    }),
  );
  expect(
    activities.find(
      (activity) => (activity.input as { agentSessionId?: string }).agentSessionId === sessionId,
    )?.token,
  ).not.toBe(otherToken.token.token);

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
    "AgentSessionEvent",
  ]);
});

dbTest("leaves a session the app opened itself unacknowledged, and sends it on", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  await connect(linear.app, workspace);
  const { factory } = await newFactory();
  await assignApp(db, organizationId, factory.id, linear.app.id);
  const before = activities.length;
  const created = sessionCreated(workspace, crypto.randomUUID());
  const own = { ...created, agentSession: { ...created.agentSession, creator: null } };
  expect(await deliver(linear, own)).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(activities.length).toBe(before);
  expect(await eventNames(factory.id)).toEqual(["AgentSessionEvent"]);
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

dbTest("issues the token of each named workspace of the assigned apps", async () => {
  const [linear, second] = [await newApp(), await newApp()];
  const [workspace, own, unnamed] = [newWorkspace(), newWorkspace(), newWorkspace()];
  await connect(linear.app, workspace);
  await connect(second.app, own);
  await connect(second.app, unnamed);
  await nameInstallation(linear.app.id, workspace.id, "lin-first");
  await nameInstallation(second.app.id, own.id, "lin-second");
  const { factory, token } = await newFactory();
  await assignApp(db, organizationId, factory.id, linear.app.id);
  await assignApp(db, organizationId, factory.id, second.app.id);

  const first = await requestLinearToken(token, "lin-first");
  expect(first.status).toBe(200);
  const body = first.body as LinearTokenResponse;
  expect(body).toEqual({
    token: expect.stringMatching(/^lin_oauth_/),
    expiresAt: expect.any(String),
    app: { name: linear.app.name, userId: workspace.userId },
  });
  expect(await requestLinearToken(token, "lin-second")).toMatchObject({
    status: 200,
    body: { app: { name: second.app.name, userId: own.userId } },
  });

  expect(await requestLinearToken(token, "nowhere")).toEqual({
    status: 404,
    body: { error: "No Linear installation named nowhere is assigned to this factory." },
  });
  expect((await requestLinearToken(token, unnamed.urlKey)).status).toBe(404);
  expect((await requestLinearToken("nope", "lin-first")).status).toBe(401);

  const status = await fetch(`${hub}${factoryStatusPath}`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": "jigs/1.2.3" },
  });
  expect((await status.json()).apps).toContainEqual({
    provider: "linear",
    name: linear.app.name,
    installations: [{ account: workspace.urlKey, installationName: "lin-first" }],
  });
});

dbTest("refreshes a token near expiry once, and stops on a refused refresh", async () => {
  const linear = await newApp();
  const workspace = newWorkspace();
  await connect(linear.app, workspace);
  await nameInstallation(linear.app.id, workspace.id, "lin-refreshed");
  const { factory } = await newFactory();
  await assignApp(db, organizationId, factory.id, linear.app.id);
  const current = await linearTokens.issue(factory.id, "lin-refreshed");
  if (!("token" in current)) throw new Error(current.error);

  const before = refreshes;
  const hours = (n: number) => Date.parse(current.token.expiresAt) - n * 60 * 60 * 1000;
  expect(await linearTokens.issue(factory.id, "lin-refreshed", hours(7))).toEqual(current);
  expect(refreshes).toBe(before);

  const nearExpiry = hours(5);
  const [one, two] = await Promise.all([
    linearTokens.issue(factory.id, "lin-refreshed", nearExpiry),
    linearTokens.issue(factory.id, "lin-refreshed", nearExpiry),
  ]);
  expect(refreshes - before).toBe(1);
  expect(one).toEqual(two);
  if (!("token" in one)) throw new Error(one.error);
  expect(one.token.token).not.toBe(current.token.token);
  expect(Date.parse(one.token.expiresAt)).toBeGreaterThan(nearExpiry + 60 * 60 * 1000);
  expect(await linearTokens.issue(factory.id, "lin-refreshed", nearExpiry)).toEqual(one);
  expect(refreshes - before).toBe(1);

  // Linear refuses a refresh token it no longer knows, as when the app is revoked.
  refreshTokens.clear();
  const later = Date.parse(one.token.expiresAt) - 60 * 1000;
  const refused = await linearTokens.issue(factory.id, "lin-refreshed", later);
  expect(refused).toEqual({
    status: 503,
    error: `Connect ${workspace.urlKey} to ${linear.app.name} again on the hub: Linear refused to refresh the token (400).`,
  });
  expect((await installationOf(linear.app, workspace))?.failure).toBe(
    "Linear refused to refresh the token (400).",
  );
  const issuedBefore = issued;
  expect(await linearTokens.issue(factory.id, "lin-refreshed", later)).toEqual(refused);
  expect(issued).toBe(issuedBefore);

  await connect(linear.app, workspace);
  const reconnected = await linearTokens.issue(factory.id, "lin-refreshed");
  if (!("token" in reconnected)) throw new Error(reconnected.error);

  // A reconnect that lands while a refused refresh is out keeps its own tokens.
  refreshTokens.clear();
  beforeRefresh = () => connect(linear.app, workspace);
  const racing = Date.parse(reconnected.token.expiresAt) - 60 * 1000;
  expect(await linearTokens.issue(factory.id, "lin-refreshed", racing)).toMatchObject({
    status: 503,
  });
  expect((await installationOf(linear.app, workspace))?.failure).toBeNull();
  expect("token" in (await linearTokens.issue(factory.id, "lin-refreshed"))).toBe(true);
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
