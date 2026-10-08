import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { afterAll, beforeAll, expect } from "vitest";
import { action as appAction } from "../app/routes/app.tsx";
import { action as factoryAction } from "../app/routes/factory.tsx";
import { action as inviteAction } from "../app/routes/invite-member.tsx";
import { action as membersAction } from "../app/routes/members.tsx";
import { action as newAppAction } from "../app/routes/new-app.tsx";
import { action as newFactoryAction } from "../app/routes/new-factory.tsx";
import { action as settingsAction } from "../app/routes/settings.tsx";
import { assignedApps } from "./apps.ts";
import { createAuth } from "./auth.ts";
import type { HubConfig } from "./config.ts";
import { connectDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { dbTest, testDatabase } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import { MessageWaiters } from "./messages.ts";

const database = testDatabase();
const db = connectDatabase(database.url);
const config: HubConfig = {
  host: "127.0.0.1",
  port: 0,
  publicUrl: new URL("http://hub.test"),
  databaseUrl: database.url,
  encryptionKey: randomBytes(32),
  signInGithubClientId: "client",
  signInGithubClientSecret: "secret",
  adminEmail: "admin@example.com",
  retentionDays: 7,
};
const auth = createAuth(config, db);
const waiters = new MessageWaiters();
const context = { config, db, auth, waiters } as AppLoadContext;
let appId: string;

beforeAll(async () => {
  await database.create();
  await migrateDatabase(db);
  await db
    .insert(schema.organization)
    .values({ id: "acme", name: "Acme", slug: "acme", createdAt: new Date() });
  const [app] = await db
    .insert(schema.apps)
    .values({
      organizationId: "acme",
      provider: "slack",
      name: "bot",
      externalId: "A1",
      settings: {},
      secrets: "",
    })
    .returning();
  if (!app) throw new Error("expected an app");
  appId = app.id;
});

afterAll(async () => {
  waiters.close();
  await db.$client.end();
  await database.drop();
});

/** A new person with this role in Acme: their user id, member id and session cookie. */
async function signedIn(role: "admin" | "member") {
  const id = `${role}-${randomBytes(4).toString("hex")}`;
  await db
    .insert(schema.user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  await db
    .insert(schema.member)
    .values({ id, organizationId: "acme", userId: id, role, createdAt: new Date() });
  const { internalAdapter, secret, authCookies } = await auth.$context;
  const { token } = await internalAdapter.createSession(id);
  return {
    id,
    cookie: `${authCookies.sessionToken.name}=${token}.${await makeSignature(token, secret)}`,
  };
}

type Fields = Record<string, string>;

type Action = (args: {
  request: Request;
  params: Record<string, string>;
  context: AppLoadContext;
}) => Promise<unknown>;

/** Post a form to a route's action as the person with `cookie`. */
const post = (
  action: unknown,
  cookie: string,
  path: string,
  fields: Fields,
  params: Record<string, string> = {},
) =>
  (action as Action)({
    request: new Request(`http://hub.test${path}`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams(fields),
    }),
    params,
    context,
  });

const onFactory = (cookie: string, factoryId: string, fields: Record<string, string>) =>
  post(factoryAction, cookie, `/factories/${factoryId}`, fields, { id: factoryId });

const reissue = (cookie: string, factoryId: string) =>
  post(newFactoryAction, cookie, "/factories/new", { intent: "reissue", factoryId });

const exists = async (factoryId: string) =>
  (await db.query.factories.findFirst({ where: eq(schema.factories.id, factoryId) })) !== undefined;

/** Every change to a factory, each expected to work. */
async function manage(cookie: string, factoryId: string, name: string) {
  expect(await onFactory(cookie, factoryId, { intent: "rename", name })).toEqual({
    message: `Renamed the factory ${name}.`,
  });
  expect(await reissue(cookie, factoryId)).toMatchObject({ connect: { id: factoryId, name } });
  expect(await onFactory(cookie, factoryId, { intent: "connect", appId })).toEqual({
    connected: appId,
  });
  expect((await assignedApps(db, factoryId)).map((app) => app.id)).toEqual([appId]);
  await onFactory(cookie, factoryId, { intent: "disconnect", appId });
  expect(await assignedApps(db, factoryId)).toEqual([]);
  const removed = await onFactory(cookie, factoryId, {
    intent: "remove",
    returnTo: "/factories?tab=all",
  });
  expect((removed as Response).headers.get("location")).toBe("/factories?tab=all");
  expect(await exists(factoryId)).toBe(false);
  expect(await onFactory(cookie, factoryId, { intent: "rename", name })).toEqual({
    error: "That factory is gone.",
  });
}

const notYours = { error: "Only an admin or whoever added this factory can change it." };

/** Every change to a factory, each expected to be refused. */
async function refused(cookie: string, factoryId: string) {
  const before = await db.query.factories.findFirst({ where: eq(schema.factories.id, factoryId) });
  for (const fields of [
    { intent: "rename", name: "taken" },
    { intent: "connect", appId },
    { intent: "disconnect", appId },
    { intent: "remove" },
  ] as Fields[]) {
    expect(await onFactory(cookie, factoryId, fields)).toEqual(notYours);
  }
  expect(await reissue(cookie, factoryId)).toEqual(notYours);
  const after = await db.query.factories.findFirst({ where: eq(schema.factories.id, factoryId) });
  expect(after).toEqual(before);
}

dbTest("lets a member add and change their own factories only", async () => {
  const alice = await signedIn("member");
  const bob = await signedIn("member");
  const added = (await post(newFactoryAction, alice.cookie, "/factories/new", {
    name: "alice laptop",
  })) as { connect: { id: string } };
  const factoryId = added.connect.id;
  const stored = await db.query.factories.findFirst({ where: eq(schema.factories.id, factoryId) });
  expect(stored?.createdBy).toBe(alice.id);

  await refused(bob.cookie, factoryId);
  const ownerless = await addFactory(db, "acme", "ci", null);
  await refused(alice.cookie, ownerless.factory.id);
  await manage(alice.cookie, factoryId, "alice desk");
});

dbTest("lets an admin change every factory", async () => {
  const admin = await signedIn("admin");
  const member = await signedIn("member");
  const theirs = await addFactory(db, "acme", "theirs", member.id);
  const ownerless = await addFactory(db, "acme", "shared", null);
  await manage(admin.cookie, theirs.factory.id, "theirs renamed");
  await manage(admin.cookie, ownerless.factory.id, "shared renamed");
});

dbTest("keeps apps, members and settings to admins", async () => {
  const member = await signedIn("member");
  const other = await signedIn("member");
  const adminOnly = { error: "Only an admin can do that." };
  expect(
    await post(newAppAction, member.cookie, "/apps/new", { provider: "slack", name: "x" }),
  ).toEqual(adminOnly);
  for (const fields of [{ intent: "rename", name: "mine" }, { intent: "remove" }] as Fields[]) {
    expect(await post(appAction, member.cookie, `/apps/${appId}`, fields, { id: appId })).toEqual(
      adminOnly,
    );
  }
  expect(
    await post(inviteAction, member.cookie, "/members/invite", {
      email: "new@example.com",
      role: "member",
    }),
  ).toEqual(adminOnly);
  for (const fields of [
    { intent: "role", memberId: other.id, role: "admin" },
    { intent: "remove", memberId: other.id },
  ] as Fields[]) {
    expect(await post(membersAction, member.cookie, "/members", fields)).toMatchObject({
      error: expect.any(String),
    });
  }
  expect(await post(settingsAction, member.cookie, "/settings", { name: "Mine" })).toMatchObject({
    error: expect.any(String),
  });
  const app = await db.query.apps.findFirst({ where: eq(schema.apps.id, appId) });
  expect(app?.name).toBe("bot");
  const organization = await db.query.organization.findFirst();
  expect(organization?.name).toBe("Acme");
  const otherMember = await db.query.member.findFirst({ where: eq(schema.member.id, other.id) });
  expect(otherMember?.role).toBe("member");

  const admin = await signedIn("admin");
  expect(
    await post(membersAction, admin.cookie, "/members", {
      intent: "role",
      memberId: other.id,
      role: "admin",
    }),
  ).toEqual({ message: `${other.id} is now an admin.` });
});
