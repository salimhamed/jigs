import type { Provider } from "@jigs-ai/hub-protocol";
import { expect } from "vitest";
import { queuedByHour, webhooksByHour } from "./activity.ts";
import * as schema from "./db/schema.ts";
import { dbTest } from "./db/test-database.ts";
import { organizationId, setUpTestHub } from "./test-hub.ts";

const { db, newFactory } = setUpTestHub();

const now = new Date("2026-10-07T12:30:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

async function received(provider: Provider, at: Date, organization = organizationId) {
  const [event] = await db
    .insert(schema.providerEvents)
    .values({ organizationId: organization, provider, name: "event", payload: {}, receivedAt: at })
    .returning();
  if (!event) throw new Error("expected an event");
  return event;
}

dbTest("counts webhooks and queued events by hour over the last 24 hours", async () => {
  const { factory } = await newFactory();
  const other = await newFactory("other");
  const recent = await received("github", hoursAgo(0.25));
  const hourAgo = await received("slack", hoursAgo(1));
  const oldest = await received("linear", hoursAgo(23.4));
  await received("pagerduty", hoursAgo(24.6));
  const theirs = await received("github", hoursAgo(0.25), "other");
  await db.insert(schema.factoryMessages).values([
    { factoryId: factory.id, kind: "event", providerEventId: recent.id, createdAt: hoursAgo(0.2) },
    { factoryId: factory.id, kind: "event", providerEventId: hourAgo.id, createdAt: hoursAgo(1) },
    { factoryId: factory.id, kind: "event", providerEventId: oldest.id, createdAt: hoursAgo(30) },
    { factoryId: factory.id, kind: "fellBehind", createdAt: hoursAgo(0.1) },
    { factoryId: other.factory.id, kind: "event", providerEventId: theirs.id },
  ]);

  const webhooks = await webhooksByHour(db, organizationId, now);
  expect(webhooks.hours).toHaveLength(24);
  expect(webhooks.hours[0]?.start).toBe("2026-10-06T13:00:00.000Z");
  expect(webhooks.hours[23]).toEqual({ start: "2026-10-07T12:00:00.000Z", count: 1 });
  expect(webhooks.hours[22]?.count).toBe(1);
  expect(webhooks.hours[0]?.count).toBe(1);
  expect(webhooks.total).toBe(3);
  expect(webhooks.byProvider).toEqual({ github: 1, linear: 1, slack: 1, pagerduty: 0 });

  const queued = await queuedByHour(db, organizationId, now);
  expect(queued.total).toBe(2);
  expect(queued.byProvider).toEqual({ github: 1, linear: 0, slack: 1, pagerduty: 0 });
  expect(queued.hours.map((hour) => hour.count).slice(-2)).toEqual([1, 1]);
});
