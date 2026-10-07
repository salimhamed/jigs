import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { assignments, factories, factoryMessages, providerEvents } from "../src/db/schema.ts";

// A connected factory long-polls at most 30 seconds at a time, and each poll marks it seen.
const ONLINE_WITHIN_MS = 2 * 60_000;

const summary = {
  id: factories.id,
  name: factories.name,
  lastSeenAt: factories.lastSeenAt,
  lastSeenVersion: factories.lastSeenVersion,
  unconfirmed: sql<number>`(
    select count(*)::int from ${factoryMessages}
    where ${factoryMessages.factoryId} = ${factories.id}
      and ${factoryMessages.position} > ${factories.cursor}
  )`,
  apps: sql<number>`(
    select count(*)::int from ${assignments} where ${assignments.factoryId} = ${factories.id}
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

/** When the Organization's factory last reached the hub, or `undefined` if there is no such factory. */
export async function readLastSeen(
  context: AppLoadContext,
  organizationId: string,
  factoryId: string,
) {
  const factory = await context.db.query.factories.findFirst({
    columns: { lastSeenAt: true },
    where: and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)),
  });
  return factory && (factory.lastSeenAt?.toISOString() ?? null);
}

/** The command a factory's owner runs to connect it with its token. */
export function connectCommand(context: AppLoadContext, token: string) {
  return `jigs hub connect ${context.config.publicUrl.origin} ${token}`;
}

const PAGE_SIZE = 25;

/** One page of a factory's messages, newest first, from before `before` when given. */
export async function readEventLog(
  context: AppLoadContext,
  factoryId: string,
  before: bigint | null,
) {
  const factory = await context.db.query.factories.findFirst({
    columns: { cursor: true },
    where: eq(factories.id, factoryId),
  });
  const cursor = factory?.cursor ?? 0n;
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
