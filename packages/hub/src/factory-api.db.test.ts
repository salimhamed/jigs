import {
  cursorPath,
  type FactoryStatus,
  factoryStatusPath,
  githubTokenPath,
  linearTokenPath,
  type Message,
  type MessagesResponse,
  maxMessagesPerResponse,
  messagesPath,
  pagerDutyTokenPath,
  slackTokenPath,
} from "@jigs-ai/hub-protocol";
import { eq, sql } from "drizzle-orm";
import { beforeAll, expect } from "vitest";
import { assignApp } from "./apps.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import { addFactory, reissueToken, removeFactory } from "./factories.ts";
import { fanOutProviderEvent } from "./messages.ts";
import { deleteExpiredMessages } from "./retention.ts";
import { CountingWaiters, organizationId, setUpTestHub } from "./test-hub.ts";

const { db, waiters, serveHub, newFactory, requestToken } = setUpTestHub();
let url: string;

beforeAll(async () => {
  url = await serveHub();
});

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  "user-agent": "jigs/1.2.3",
});

async function poll(token: string, wait = 0, signal?: AbortSignal) {
  const response = await fetch(`${url}${messagesPath}?wait=${wait}`, {
    headers: headers(token),
    signal,
  });
  return { status: response.status, body: (await response.json()) as MessagesResponse };
}

async function confirm(token: string, position: string) {
  const response = await fetch(`${url}${cursorPath}`, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify({ position }),
  });
  return response.status;
}

// One app per set of factories, assigned to exactly those.
const appsByFactories = new Map<string, string>();
async function appFor(factoryIds: string[], organization = organizationId) {
  const key = `${organization}:${factoryIds.join()}`;
  const known = appsByFactories.get(key);
  if (known) return known;
  const [app] = await db
    .insert(schema.apps)
    .values({
      organizationId: organization,
      provider: "github",
      name: key,
      externalId: String(appsByFactories.size + 1),
      settings: {},
      secrets: "",
    })
    .returning();
  if (!app) throw new Error("expected an app");
  for (const factoryId of factoryIds) await assignApp(db, organization, factoryId, app.id);
  appsByFactories.set(key, app.id);
  return app.id;
}

const send = async (factoryIds: string[], name = "issues") =>
  (
    await fanOutProviderEvent(db, waiters, {
      organizationId,
      appId: await appFor(factoryIds),
      installationId: null,
      provider: "github",
      name,
      payload: { action: name },
    })
  ).id;

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

dbTest("refuses unknown tokens and records who called", async () => {
  const { factory, token } = await newFactory();
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect((await fetch(`${url}${messagesPath}`)).status).toBe(401);
  expect((await poll("nope")).status).toBe(401);
  expect(await confirm("nope", "1")).toBe(401);

  expect(await poll(token)).toEqual({ status: 200, body: { messages: [] } });
  const seen = await db.query.factories.findFirst({ where: eq(schema.factories.id, factory.id) });
  expect(seen).toMatchObject({ lastSeenVersion: "1.2.3", lastSeenAt: expect.any(Date) });

  const reissued = await reissueToken(db, waiters, organizationId, factory.id);
  if (!reissued) throw new Error("expected a token");
  expect(reissued).toMatch(/^[0-9a-f]{64}$/);
  expect((await poll(token)).status).toBe(401);
  expect((await poll(reissued)).status).toBe(200);
  expect(await reissueToken(db, waiters, "other", factory.id)).toBeNull();

  await removeFactory(db, waiters, organizationId, factory.id);
  expect((await poll(reissued)).status).toBe(401);
});

dbTest("reports the factory, its Organization and only its assigned apps", async () => {
  const { factory, token } = await newFactory();
  const other = await newFactory();
  const assigned = await appFor([factory.id, other.factory.id]);
  await appFor([other.factory.id]);
  await db.insert(schema.installations).values([
    { appId: assigned, organizationId, externalId: "1", account: "widgets" },
    {
      appId: assigned,
      organizationId,
      externalId: "2",
      account: "acme",
      installationName: "gh-acme",
    },
  ]);
  const bare = await appFor([factory.id]);

  const status = async (bearer: string) => {
    const response = await fetch(`${url}${factoryStatusPath}`, { headers: headers(bearer) });
    return { status: response.status, body: await response.json() };
  };
  expect((await status("nope")).status).toBe(401);
  const names = new Map(
    (await db.select().from(schema.apps)).map((app) => [app.id, app.name] as const),
  );
  const { status: code, body } = await status(token);
  expect(code).toBe(200);
  expect(body).toEqual({
    factory: { name: factory.name },
    organization: { name: "Acme" },
    apps: expect.arrayContaining([
      {
        provider: "github",
        name: names.get(assigned),
        installations: [
          { account: "acme", installationName: "gh-acme" },
          { account: "widgets", installationName: null },
        ],
      },
      { provider: "github", name: names.get(bare), installations: [] },
    ]),
  } satisfies FactoryStatus);
  expect(body.apps).toHaveLength(2);
});

dbTest("returns messages in batches after a cursor that only moves forward", async () => {
  const { factory, token } = await newFactory();
  const other = await newFactory();
  for (let i = 0; i < maxMessagesPerResponse + 5; i += 1) await send([factory.id], `e${i}`);
  await send([other.factory.id], "theirs");

  const first = (await poll(token)).body.messages;
  expect(first).toHaveLength(maxMessagesPerResponse);
  const [head] = first as [Extract<Message, { kind: "event" }>];
  expect(head).toMatchObject({
    kind: "event",
    event: { provider: "github", name: "e0", payload: { action: "e0" } },
  });
  expect(Date.parse(head.event.receivedAt)).not.toBeNaN();
  const positions = first.map((message) => BigInt(message.position));
  expect(positions).toEqual(positions.toSorted((a, b) => (a < b ? -1 : 1)));

  const last = first.at(-1)?.position ?? "";
  expect(await poll(token)).toEqual({ status: 200, body: { messages: first } });
  expect(await confirm(token, last)).toBe(204);
  const rest = (await poll(token)).body.messages;
  expect(rest.map((message) => message.kind === "event" && message.event.name)).toEqual([
    "e100",
    "e101",
    "e102",
    "e103",
    "e104",
  ]);

  expect(await confirm(token, first[0]?.position ?? "")).toBe(204);
  expect((await poll(token)).body.messages).toEqual(rest);
  expect(await confirm(token, "-1")).toBe(400);
  expect(await confirm(token, "99999999999999999999")).toBe(400);
});

dbTest("holds a poll until a message arrives or the wait ends", async () => {
  const { factory, token } = await newFactory();
  const started = Date.now();
  const empty = await poll(token, 1);
  expect(empty.body.messages).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);

  const held = poll(token, 30);
  await until(() => waiters.held(factory.id) === 1);
  const sentAt = Date.now();
  await send([factory.id]);
  const { body } = await held;
  expect(body.messages).toHaveLength(1);
  expect(Date.now() - sentAt).toBeLessThan(5000);
  expect(waiters.held(factory.id)).toBe(0);
});

dbTest("releases a waiting poll when its factory disconnects", async () => {
  const { factory, token } = await newFactory();
  const controller = new AbortController();
  const held = poll(token, 30, controller.signal);
  await until(() => waiters.held(factory.id) === 1);
  controller.abort();
  await expect(held).rejects.toThrow();
  await until(() => waiters.held(factory.id) === 0);
});

dbTest("answers waiting polls at once when the waiters close", async () => {
  const closing = new CountingWaiters();
  const { factory } = await newFactory();
  const wait = closing.wait(factory.id, 30_000, new AbortController().signal);
  closing.close();
  await wait;
  await closing.wait(factory.id, 30_000, new AbortController().signal);
  expect(closing.held(factory.id)).toBe(0);
});

dbTest("tells a factory once when expired messages it never confirmed are deleted", async () => {
  const behind = await newFactory();
  const caughtUp = await newFactory();
  const ids = [behind.factory.id, caughtUp.factory.id];
  const kept = await send(ids, "kept");
  const expired = await send(ids, "expired");
  await db
    .update(schema.factoryMessages)
    .set({ createdAt: sql`now() - interval '8 days'` })
    .where(eq(schema.factoryMessages.providerEventId, expired));
  await db
    .update(schema.factoryMessages)
    .set({ createdAt: sql`now() - interval '3 days'` })
    .where(eq(schema.factoryMessages.providerEventId, kept));
  const messages = (await poll(caughtUp.token)).body.messages;
  expect(await confirm(caughtUp.token, messages.at(-1)?.position ?? "")).toBe(204);

  await deleteExpiredMessages(db, waiters, 7);
  await deleteExpiredMessages(db, waiters, 7);
  const told = (await poll(behind.token)).body.messages;
  expect(told.map((message) => message.kind)).toEqual(["event", "fellBehind"]);
  expect((await poll(caughtUp.token)).body.messages).toEqual([]);
  const events = await db.select({ id: schema.providerEvents.id }).from(schema.providerEvents);
  expect(events.map((event) => event.id)).not.toContain(expired);
  expect(events.map((event) => event.id)).toContain(kept);

  // The unconfirmed fellBehind expires too: the factory is told again, once.
  await db
    .update(schema.factoryMessages)
    .set({ createdAt: sql`now() - interval '8 days'` })
    .where(eq(schema.factoryMessages.factoryId, behind.factory.id));
  await deleteExpiredMessages(db, waiters, 7);
  expect((await poll(behind.token)).body.messages.map((message) => message.kind)).toEqual([
    "fellBehind",
  ]);
});

dbTest("removing a factory removes its messages", async () => {
  const { factory } = await newFactory();
  await send([factory.id]);
  await removeFactory(db, waiters, organizationId, factory.id);
  const left = await db
    .select()
    .from(schema.factoryMessages)
    .where(eq(schema.factoryMessages.factoryId, factory.id));
  expect(left).toEqual([]);
});

dbTest("refuses a held poll once its token is re-issued or its factory removed", async () => {
  const { factory, token } = await newFactory();
  const held = poll(token, 30);
  await until(() => waiters.held(factory.id) === 1);
  const reissued = await reissueToken(db, waiters, organizationId, factory.id);
  expect((await held).status).toBe(401);

  const again = poll(reissued ?? "", 30);
  await until(() => waiters.held(factory.id) === 1);
  await removeFactory(db, waiters, organizationId, factory.id);
  expect((await again).status).toBe(401);
});

dbTest("fans an event out only to the factories its app is assigned to", async () => {
  const { factory, token } = await newFactory();
  const unassigned = await newFactory();
  const removed = await newFactory();
  const foreign = await addFactory(db, "other", "theirs");
  const appId = await appFor([factory.id, removed.factory.id, foreign.factory.id]);
  await removeFactory(db, waiters, organizationId, removed.factory.id);
  const assigned = await db
    .select({ factoryId: schema.assignments.factoryId })
    .from(schema.assignments)
    .where(eq(schema.assignments.appId, appId));
  expect(assigned).toEqual([{ factoryId: factory.id }]);

  await send([factory.id, removed.factory.id, foreign.factory.id], "shared");
  expect((await poll(token)).body.messages).toMatchObject([{ event: { name: "shared" } }]);
  expect((await poll(unassigned.token)).body.messages).toEqual([]);
  expect((await poll(foreign.token)).body.messages).toEqual([]);
});

dbTest("names each event's installation as it is when the event is read", async () => {
  const { factory, token } = await newFactory();
  const appId = await appFor([factory.id]);
  const [installation] = await db
    .insert(schema.installations)
    .values({ appId, organizationId, externalId: "named-later", account: "acme" })
    .returning();
  if (!installation) throw new Error("expected an installation");
  await fanOutProviderEvent(db, waiters, {
    organizationId,
    appId,
    installationId: installation.id,
    provider: "github",
    name: "issues",
    payload: {},
  });
  const installationNames = async () =>
    (await poll(token)).body.messages.map(
      (message) => message.kind === "event" && message.event.installationName,
    );

  expect(await installationNames()).toEqual([null]);
  const rename = (installationName: string) =>
    db
      .update(schema.installations)
      .set({ installationName })
      .where(eq(schema.installations.id, installation.id));
  await rename("gh-later");
  expect(await installationNames()).toEqual(["gh-later"]);
  await rename("gh-renamed");
  expect(await installationNames()).toEqual(["gh-renamed"]);
  await db.delete(schema.installations).where(eq(schema.installations.id, installation.id));
  expect(await installationNames()).toEqual([null]);
});

dbTest("refuses a token request that names no installation", async () => {
  const { token } = await newFactory();
  for (const path of [githubTokenPath, linearTokenPath, slackTokenPath, pagerDutyTokenPath]) {
    for (const body of [{}, { installationName: "" }, { installationName: 7 }]) {
      expect(await requestToken(path, token, body)).toEqual({
        status: 400,
        body: { error: "installationName must name an installation." },
      });
    }
    expect(await requestToken(path, token, { installationName: "nothing" })).toMatchObject({
      status: 404,
    });
  }
});
