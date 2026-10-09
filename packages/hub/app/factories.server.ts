import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { assignedApps } from "../src/apps.ts";
import {
  apps,
  assignments,
  factories,
  factoryMessages,
  providerEvents,
  user,
} from "../src/db/schema.ts";
import { listInstalledApps } from "./apps.server.ts";

// A connected factory long-polls at most 30 seconds at a time, and each poll marks it seen.
const ONLINE_WITHIN_MS = 2 * 60_000;

// Drizzle leaves column names unqualified when a query selects from one table, so the
// subqueries name the outer factory's columns themselves.
const summary = {
  id: factories.id,
  name: factories.name,
  lastSeenAt: factories.lastSeenAt,
  lastSeenVersion: factories.lastSeenVersion,
  cursor: factories.cursor,
  createdBy: factories.createdBy,
  addedBy: sql<
    string | null
  >`(select ${user.name} from ${user} where ${user.id} = "factories"."created_by")`,
  unconfirmed: sql<number>`(
    select count(*)::int from ${factoryMessages}
    where ${factoryMessages.factoryId} = "factories"."id"
      and ${factoryMessages.position} > "factories"."cursor"
  )`,
  appNames: sql<string[]>`array(
    select ${apps.name} from ${assignments}
    join ${apps} on ${apps.id} = ${assignments.appId}
    where ${assignments.factoryId} = "factories"."id"
    order by ${apps.name}
  )`,
};

function withStatus<T extends { lastSeenAt: Date | null }>({ lastSeenAt, ...factory }: T) {
  return {
    ...factory,
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    online: lastSeenAt !== null && Date.now() - lastSeenAt.getTime() < ONLINE_WITHIN_MS,
  };
}

/** An Organization's factories, each with whether it is online and how many messages it has not confirmed. */
export async function listFactories(context: AppLoadContext, organizationId: string) {
  const rows = await context.db
    .select(summary)
    .from(factories)
    .where(eq(factories.organizationId, organizationId))
    .orderBy(asc(factories.name));
  return rows.map(withStatus);
}

/** One factory of the Organization as {@link listFactories} describes it, or `null`. */
export async function readFactory(
  context: AppLoadContext,
  organizationId: string,
  factoryId: string,
) {
  const [row] = await context.db
    .select(summary)
    .from(factories)
    .where(and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)));
  return row ? withStatus(row) : null;
}

/** What a factory's owner copies to connect it: a line for its `jigs.config.ts` and one for its environment. */
export function connectLines(context: AppLoadContext, token: string) {
  return {
    config: `hub: { url: "${context.config.publicUrl.origin}" }`,
    env: `JIGS_HUB_TOKEN=${token}`,
  };
}

const PAGE_SIZE = 50;

/**
 * One page of a factory's messages, newest first, from before `before` when
 * given, without their payloads.
 */
export async function readEventLog(
  context: AppLoadContext,
  { id: factoryId, cursor }: { id: string; cursor: bigint },
  before: bigint | null,
) {
  const rows = await context.db
    .select({
      position: factoryMessages.position,
      kind: factoryMessages.kind,
      createdAt: factoryMessages.createdAt,
      provider: providerEvents.provider,
      name: providerEvents.name,
      receivedAt: providerEvents.receivedAt,
    })
    .from(factoryMessages)
    .leftJoin(providerEvents, eq(providerEvents.id, factoryMessages.providerEventId))
    .where(
      and(
        eq(factoryMessages.factoryId, factoryId),
        before === null ? undefined : lt(factoryMessages.position, before),
      ),
    )
    .orderBy(desc(factoryMessages.position))
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  return {
    messages: page.map((row) => ({
      position: String(row.position),
      kind: row.kind,
      provider: row.provider,
      name: row.name,
      receivedAt: (row.receivedAt ?? row.createdAt).toISOString(),
      confirmed: row.position <= cursor,
    })),
    older: rows.length > PAGE_SIZE ? String(page.at(-1)?.position) : null,
  };
}

/** How many messages the hub holds for a factory. */
export async function countEvents(context: AppLoadContext, factoryId: string) {
  const [row] = await context.db
    .select({ count: sql<number>`count(*)::int` })
    .from(factoryMessages)
    .where(eq(factoryMessages.factoryId, factoryId));
  return row?.count ?? 0;
}

/** The payload of one of the Organization's factory's events, as indented JSON, or `null`. */
export async function readEventPayload(
  context: AppLoadContext,
  organizationId: string,
  factoryId: string,
  position: bigint,
) {
  const [row] = await context.db
    .select({ payload: providerEvents.payload })
    .from(factoryMessages)
    .innerJoin(factories, eq(factories.id, factoryMessages.factoryId))
    .innerJoin(providerEvents, eq(providerEvents.id, factoryMessages.providerEventId))
    .where(
      and(
        eq(factoryMessages.position, position),
        eq(factoryMessages.factoryId, factoryId),
        eq(factories.organizationId, organizationId),
      ),
    );
  return row ? JSON.stringify(row.payload, null, 2) : null;
}

/** When the factory was last sent an event of each app, by app id. */
export async function readLastEvents(context: AppLoadContext, factoryId: string) {
  const rows = await context.db
    .select({
      appId: providerEvents.appId,
      receivedAt: sql<Date>`max(${providerEvents.receivedAt})`,
    })
    .from(factoryMessages)
    .innerJoin(providerEvents, eq(providerEvents.id, factoryMessages.providerEventId))
    .where(eq(factoryMessages.factoryId, factoryId))
    .groupBy(providerEvents.appId);
  return Object.fromEntries(
    rows.flatMap(({ appId, receivedAt }) =>
      appId === null ? [] : [[appId, new Date(receivedAt).toISOString()]],
    ),
  ) as Record<string, string>;
}

/** The apps connected to a factory, with their last events, and the rest of the Organization's. */
export async function readFactoryApps(
  context: AppLoadContext,
  organizationId: string,
  factoryId: string,
) {
  const [connected, lastEvents, organizationApps] = await Promise.all([
    assignedApps(context.db, factoryId),
    readLastEvents(context, factoryId),
    listInstalledApps(context, organizationId),
  ]);
  return {
    connected: connected.map((app) => ({ ...app, lastEventAt: lastEvents[app.id] ?? null })),
    hasApps: organizationApps.length > 0,
    available: organizationApps.filter((app) => !connected.some(({ id }) => id === app.id)),
  };
}
