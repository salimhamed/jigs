import { type Provider, providers } from "@jigs-ai/hub-protocol";
import { and, eq, gte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { HubDatabase } from "./db/database.ts";
import { factories, factoryMessages, providerEvents } from "./db/schema.ts";

const HOUR = 3_600_000;

/** Counts per hour over the last 24 hours, oldest first; the last hour is the one under way. */
export interface HourlyActivity {
  hours: { start: string; count: number }[];
  byProvider: Record<Provider, number>;
  total: number;
}

/** The Organization's provider events, by the hour they were received. */
export async function webhooksByHour(
  db: HubDatabase,
  organizationId: string,
  now = new Date(),
): Promise<HourlyActivity> {
  const since = windowStart(now);
  const rows = await db
    .select({
      hour: hourOf(providerEvents.receivedAt, since),
      provider: providerEvents.provider,
      count: sql<number>`count(*)::int`,
    })
    .from(providerEvents)
    .where(
      and(eq(providerEvents.organizationId, organizationId), gte(providerEvents.receivedAt, since)),
    )
    .groupBy(sql`hour`, providerEvents.provider);
  return byHour(since, rows);
}

/** The provider events the hub delivered to the Organization's factories, by the hour each was queued. */
export async function deliveriesByHour(
  db: HubDatabase,
  organizationId: string,
  now = new Date(),
): Promise<HourlyActivity> {
  const since = windowStart(now);
  const rows = await db
    .select({
      hour: hourOf(factoryMessages.createdAt, since),
      provider: providerEvents.provider,
      count: sql<number>`count(*)::int`,
    })
    .from(factoryMessages)
    .innerJoin(factories, eq(factories.id, factoryMessages.factoryId))
    .innerJoin(providerEvents, eq(providerEvents.id, factoryMessages.providerEventId))
    .where(and(eq(factories.organizationId, organizationId), gte(factoryMessages.createdAt, since)))
    .groupBy(sql`hour`, providerEvents.provider);
  return byHour(since, rows);
}

const hourOf = (column: AnyPgColumn, since: Date) =>
  sql<Date>`date_bin('1 hour', ${column}, ${since})`.as("hour");

const windowStart = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR - 23 * HOUR);

function byHour(
  since: Date,
  rows: { hour: Date | string; provider: Provider; count: number }[],
): HourlyActivity {
  const hours = Array.from({ length: 24 }, (_, index) => ({
    start: new Date(since.getTime() + index * HOUR).toISOString(),
    count: 0,
  }));
  const byProvider = Object.fromEntries(providers.map((provider) => [provider, 0])) as Record<
    Provider,
    number
  >;
  for (const { hour, provider, count } of rows) {
    const slot = hours[Math.round((new Date(hour).getTime() - since.getTime()) / HOUR)];
    if (slot) slot.count += count;
    byProvider[provider] += count;
  }
  return { hours, byProvider, total: hours.reduce((sum, { count }) => sum + count, 0) };
}
