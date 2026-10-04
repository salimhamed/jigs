import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { factories, factoryMessages, providerEvents } from "../src/db/schema.ts";

/** An Organization's factories, with how many messages each has not confirmed. */
export async function listFactories(context: AppLoadContext, organizationId: string) {
  const rows = await context.db
    .select({
      id: factories.id,
      name: factories.name,
      lastSeenAt: factories.lastSeenAt,
      lastSeenVersion: factories.lastSeenVersion,
      unconfirmed: sql<number>`(
        select count(*)::int from ${factoryMessages}
        where ${factoryMessages.factoryId} = ${factories.id}
          and ${factoryMessages.position} > ${factories.cursor}
      )`,
    })
    .from(factories)
    .where(eq(factories.organizationId, organizationId))
    .orderBy(asc(factories.name));
  return rows.map((row) => ({ ...row, lastSeenAt: row.lastSeenAt?.toISOString() ?? null }));
}

/** The command a factory's owner runs to connect it with its token. */
export function connectCommand(context: AppLoadContext, token: string) {
  return `jigs hub connect ${context.config.publicUrl.origin} ${token}`;
}

const PAGE_SIZE = 25;

/** One page of a factory's messages, newest first, from before `before` when given. */
export async function readEventLog(
  context: AppLoadContext,
  organizationId: string,
  factoryId: string,
  before: bigint | null,
) {
  const factory = await context.db.query.factories.findFirst({
    columns: { name: true, cursor: true },
    where: and(eq(factories.id, factoryId), eq(factories.organizationId, organizationId)),
  });
  if (!factory) return null;
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
    name: factory.name,
    messages: page.map((row) => ({
      position: String(row.position),
      kind: row.kind,
      provider: row.provider,
      name: row.name,
      receivedAt: (row.receivedAt ?? row.createdAt).toISOString(),
      payload: row.payload === null ? null : JSON.stringify(row.payload, null, 2),
      confirmed: row.position <= factory.cursor,
    })),
    older: rows.length > PAGE_SIZE ? String(page.at(-1)?.position) : null,
  };
}
