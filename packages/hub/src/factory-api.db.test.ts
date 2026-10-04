import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  cursorPath,
  type Message,
  type MessagesResponse,
  maxMessagesPerResponse,
  messagesPath,
} from "@jigs-ai/hub-protocol";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, expect } from "vitest";
import { connectDatabase, type HubDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { createTestDatabase, dbTest } from "./db/test-database.ts";
import { addFactory, reissueToken, removeFactory } from "./factories.ts";
import { createFactoryApi } from "./factory-api.ts";
import { fanOutProviderEvent, MessageWaiters } from "./messages.ts";
import { deleteExpiredMessages } from "./retention.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: HubDatabase;
let server: Server;
let url: string;
const waiters = new MessageWaiters();
const organizationId = "acme";

beforeAll(async () => {
  database = await createTestDatabase();
  db = connectDatabase(database.url);
  await migrateDatabase(db);
  await db.insert(schema.organization).values([
    { id: organizationId, name: "Acme", slug: "acme", createdAt: new Date() },
    { id: "other", name: "Other", slug: "other", createdAt: new Date() },
  ]);
  server = express().use(createFactoryApi(db, waiters)).listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  waiters.close();
  server?.closeAllConnections();
  server?.close();
  await db?.$client.end();
  await database?.drop();
});

let named = 0;
async function newFactory() {
  named += 1;
  return addFactory(db, organizationId, `factory ${named}`);
}

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

const send = (factoryIds: string[], name = "issues") =>
  fanOutProviderEvent(
    db,
    waiters,
    { organizationId, provider: "github", name, payload: { action: name } },
    factoryIds,
  );

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

dbTest("refuses unknown tokens and records who called", async () => {
  const { factory, token } = await newFactory();
  expect((await fetch(`${url}${messagesPath}`)).status).toBe(401);
  expect((await poll("nope")).status).toBe(401);
  expect(await confirm("nope", "1")).toBe(401);

  expect(await poll(token)).toEqual({ status: 200, body: { messages: [] } });
  const seen = await db.query.factories.findFirst({ where: eq(schema.factories.id, factory.id) });
  expect(seen).toMatchObject({ lastSeenVersion: "1.2.3", lastSeenAt: expect.any(Date) });

  const reissued = await reissueToken(db, waiters, organizationId, factory.id);
  if (!reissued) throw new Error("expected a token");
  expect((await poll(token)).status).toBe(401);
  expect((await poll(reissued)).status).toBe(200);
  expect(await reissueToken(db, waiters, "other", factory.id)).toBeNull();

  await removeFactory(db, waiters, organizationId, factory.id);
  expect((await poll(reissued)).status).toBe(401);
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
  await until(() => waiters.waiting(factory.id) === 1);
  const sentAt = Date.now();
  await send([factory.id]);
  const { body } = await held;
  expect(body.messages).toHaveLength(1);
  expect(Date.now() - sentAt).toBeLessThan(5000);
  expect(waiters.waiting(factory.id)).toBe(0);
});

dbTest("releases a waiting poll when its factory disconnects", async () => {
  const { factory, token } = await newFactory();
  const controller = new AbortController();
  const held = poll(token, 30, controller.signal);
  await until(() => waiters.waiting(factory.id) === 1);
  controller.abort();
  await expect(held).rejects.toThrow();
  await until(() => waiters.waiting(factory.id) === 0);
});

dbTest("answers waiting polls at once when the waiters close", async () => {
  const closing = new MessageWaiters();
  const { factory } = await newFactory();
  const wait = closing.wait(factory.id, 30_000, new AbortController().signal);
  closing.close();
  await wait;
  await closing.wait(factory.id, 30_000, new AbortController().signal);
  expect(closing.waiting(factory.id)).toBe(0);
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
  await until(() => waiters.waiting(factory.id) === 1);
  const reissued = await reissueToken(db, waiters, organizationId, factory.id);
  expect((await held).status).toBe(401);

  const again = poll(reissued ?? "", 30);
  await until(() => waiters.waiting(factory.id) === 1);
  await removeFactory(db, waiters, organizationId, factory.id);
  expect((await again).status).toBe(401);
});

dbTest("fans an event out only to the Organization's factories that still exist", async () => {
  const { factory, token } = await newFactory();
  const removed = await newFactory();
  await removeFactory(db, waiters, organizationId, removed.factory.id);
  const foreign = await addFactory(db, "other", "theirs");
  await send([factory.id, removed.factory.id, foreign.factory.id], "shared");
  expect((await poll(token)).body.messages).toMatchObject([{ event: { name: "shared" } }]);
  expect((await poll(foreign.token)).body.messages).toEqual([]);
});
