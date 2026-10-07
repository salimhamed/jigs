import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { apps, assignments, factories, factoryMessages, providerEvents } from "../src/db/schema.ts";

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

/** The command a factory's owner runs to connect it with its token. */
export function connectCommand(context: AppLoadContext, token: string) {
  return `jigs hub connect ${context.config.publicUrl.origin} ${token}`;
}

const PAGE_SIZE = 25;

/** One page of a factory's messages, newest first, from before `before` when given. */
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
      payload: providerEvents.payload,
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
      payload: row.payload === null ? null : JSON.stringify(row.payload, null, 2),
      confirmed: row.position <= cursor,
    })),
    older: rows.length > PAGE_SIZE ? String(page.at(-1)?.position) : null,
  };
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
