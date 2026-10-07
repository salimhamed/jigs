import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { afterAll, beforeAll, expect } from "vitest";
import { action as factoryAction } from "../app/routes/factory.tsx";
import { action as newFactoryAction } from "../app/routes/new-factory.tsx";
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

beforeAll(async () => {
  await database.create();
  await migrateDatabase(db);
  await db
    .insert(schema.organization)
    .values({ id: "acme", name: "Acme", slug: "acme", createdAt: new Date() });
});

afterAll(async () => {
  waiters.close();
  await db.$client.end();
  await database.drop();
});

/** The session cookie of a new person with this role in Acme. */
async function signedIn(role: "admin" | "member") {
  const id = `${role}-${randomBytes(4).toString("hex")}`;
  await db
    .insert(schema.user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  await db
    .insert(schema.member)
    .values({ id, organizationId: "acme", userId: id, role, createdAt: new Date() });
  const adapter = (await auth.$context).internalAdapter;
  const { token } = await adapter.createSession(id);
  const { secret, authCookies } = await auth.$context;
  return `${authCookies.sessionToken.name}=${token}.${await makeSignature(token, secret)}`;
}

const post = (cookie: string, path: string, fields: Record<string, string>) =>
  new Request(`http://hub.test${path}`, {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams(fields),
  });

dbTest("lets members connect and disconnect apps, and nothing else", async () => {
  const { factory } = await addFactory(db, "acme", "laptop");
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
  const member = await signedIn("member");
  const onFactory = (fields: Record<string, string>) =>
    factoryAction({
      request: post(member, `/factories/${factory.id}`, fields),
      params: { id: factory.id },
      context,
    } as Parameters<typeof factoryAction>[0]);
  const connectedNames = async () =>
    (await assignedApps(db, factory.id)).map((connected) => connected.name);

  expect(await onFactory({ intent: "connect", appId: app.id })).toEqual({ connected: app.id });
  expect(await connectedNames()).toEqual(["bot"]);
  await onFactory({ intent: "disconnect", appId: app.id });
  expect(await connectedNames()).toEqual([]);

  const refused = { error: "Only an admin can do that." };
  expect(await onFactory({ intent: "rename", name: "mine" })).toEqual(refused);
  expect(await onFactory({ intent: "remove" })).toEqual(refused);
  expect(
    await newFactoryAction({
      request: post(member, "/factories/new", { intent: "reissue", factoryId: factory.id }),
      params: {},
      context,
    } as Parameters<typeof newFactoryAction>[0]),
  ).toEqual(refused);
  const stored = await db.query.factories.findFirst({
    where: eq(schema.factories.id, factory.id),
  });
  expect(stored).toMatchObject({ name: "laptop", tokenHash: factory.tokenHash });

  const admin = await signedIn("admin");
  const renamed = await factoryAction({
    request: post(admin, `/factories/${factory.id}`, { intent: "rename", name: "desk" }),
    params: { id: factory.id },
    context,
  } as Parameters<typeof factoryAction>[0]);
  expect(renamed).toEqual({ message: "Renamed the factory desk." });
});
