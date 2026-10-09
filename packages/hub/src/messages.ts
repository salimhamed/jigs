import { type Message, maxMessagesPerResponse, type Provider } from "@jigs-ai/hub-protocol";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { HubDatabase, Transaction } from "./db/database.ts";
import {
  assignments,
  factories,
  factoryMessages,
  installations,
  providerEvents,
} from "./db/schema.ts";

/**
 * Factories holding a long poll open, woken when a message is appended for
 * them. The hub is one process, so waking stays in memory.
 */
export class MessageWaiters {
  readonly #waiting = new Map<string, Set<() => void>>();
  #closed = false;

  /** Resolve when the factory is woken, `ms` elapses, `signal` aborts or the waiters close. */
  wait(factoryId: string, ms: number, signal: AbortSignal): Promise<void> {
    if (this.#closed || signal.aborted) return Promise.resolve();
    const waiting = this.#waiting;
    return new Promise((resolve) => {
      const own = waiting.get(factoryId) ?? new Set();
      waiting.set(factoryId, own);
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      own.add(done);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        own.delete(done);
        if (own.size === 0 && waiting.get(factoryId) === own) waiting.delete(factoryId);
        resolve();
      }
    });
  }

  wake(factoryIds: Iterable<string>): void {
    for (const id of factoryIds) {
      for (const done of [...(this.#waiting.get(id) ?? [])]) done();
    }
  }

  /** Release every wait, now and from now on, so shutdown does not sit out a long poll. */
  close(): void {
    this.#closed = true;
    this.wake([...this.#waiting.keys()]);
  }
}

/**
 * Hold this lock for the rest of a transaction that appends messages.
 *
 * @remarks
 * Positions come from one sequence but transactions commit in their own
 * order. Were two to append at once, the later position could commit first,
 * the factory could confirm it, and the earlier one would land behind its
 * cursor, never to be read.
 */
export async function lockAppends(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${APPEND_LOCK})`);
}

const APPEND_LOCK = 7_001_661;

/** A provider event the hub received through one of an Organization's apps, before it is stored. */
export interface ReceivedProviderEvent {
  organizationId: string;
  appId: string;
  /** The hub's id for the installation it came through, `null` when it names none the hub has. */
  installationId: string | null;
  provider: Provider;
  name: string;
  payload: unknown;
  /** The provider's own id for the event; a second event with the same key for the app is not stored or sent. */
  dedupeKey?: string;
}

/**
 * Store a provider event once and append an `event` message for each factory
 * the app is assigned to, then wake their long polls. Returns the stored
 * event's id and the factories it was appended for: none when the app already
 * has an event with the same dedupe key, whose id it returns.
 */
export async function fanOutProviderEvent(
  db: HubDatabase,
  waiters: MessageWaiters,
  event: ReceivedProviderEvent,
): Promise<{ id: string; appendedTo: string[] }> {
  const { id, appendedTo } = await db.transaction(async (tx) => {
    await lockAppends(tx);
    const [stored] = await tx
      .insert(providerEvents)
      .values(event)
      .onConflictDoNothing()
      .returning({ id: providerEvents.id });
    if (!stored) {
      const [earlier] = await tx
        .select({ id: providerEvents.id })
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.appId, event.appId),
            eq(providerEvents.dedupeKey, event.dedupeKey ?? ""),
          ),
        );
      if (!earlier) throw new Error("storing a provider event returned no row");
      return { id: earlier.id, appendedTo: [] };
    }
    const appended = await tx.execute<{ factory_id: string }>(sql`
      insert into ${factoryMessages} (factory_id, kind, provider_event_id)
      select ${factories.id}, 'event', ${stored.id} from ${factories}
      join ${assignments} on ${assignments.factoryId} = ${factories.id}
      where ${assignments.appId} = ${event.appId}
        and ${factories.organizationId} = ${event.organizationId}
      returning factory_id
    `);
    return { id: stored.id, appendedTo: appended.rows.map((row) => row.factory_id) };
  });
  waiters.wake(appendedTo);
  return { id, appendedTo };
}

/** The oldest messages after the factory's confirmed cursor, at most one response's worth. */
export async function readMessages(db: HubDatabase, factoryId: string): Promise<Message[]> {
  const cursor = db
    .select({ cursor: factories.cursor })
    .from(factories)
    .where(eq(factories.id, factoryId));
  const rows = await db
    .select({
      position: factoryMessages.position,
      kind: factoryMessages.kind,
      event: providerEvents,
      installationName: installations.installationName,
    })
    .from(factoryMessages)
    .leftJoin(providerEvents, eq(providerEvents.id, factoryMessages.providerEventId))
    .leftJoin(installations, eq(installations.id, providerEvents.installationId))
    .where(
      and(eq(factoryMessages.factoryId, factoryId), gt(factoryMessages.position, sql`(${cursor})`)),
    )
    .orderBy(asc(factoryMessages.position))
    .limit(maxMessagesPerResponse);
  return rows.map(({ position, kind, event, installationName }): Message => {
    if (kind === "fellBehind") return { position: String(position), kind };
    if (!event) throw new Error(`event message ${position} has no provider event`);
    return {
      position: String(position),
      kind,
      event: {
        id: event.id,
        provider: event.provider,
        installationName,
        name: event.name,
        receivedAt: event.receivedAt.toISOString(),
        payload: event.payload,
      },
    };
  });
}

/** Confirm every message up to `position`. A cursor only moves forward. */
export async function confirmCursor(
  db: HubDatabase,
  factoryId: string,
  position: bigint,
): Promise<void> {
  await db
    .update(factories)
    .set({ cursor: sql`greatest(${factories.cursor}, ${position.toString()}::bigint)` })
    .where(eq(factories.id, factoryId));
}
