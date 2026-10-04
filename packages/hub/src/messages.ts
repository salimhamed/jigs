import { type Message, maxMessagesPerResponse, type Provider } from "@jigs-ai/hub-protocol";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { HubDatabase } from "./db/database.ts";
import { factories, factoryMessages, providerEvents } from "./db/schema.ts";

type Transaction = Parameters<Parameters<HubDatabase["transaction"]>[0]>[0];

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

  /** How many long polls a factory holds open. */
  waiting(factoryId: string): number {
    return this.#waiting.get(factoryId)?.size ?? 0;
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

/** A provider event the hub received, before it is stored. */
export interface ReceivedProviderEvent {
  organizationId: string;
  provider: Provider;
  name: string;
  payload: unknown;
}

/**
 * Store a provider event once and append an `event` message for each factory,
 * then wake their long polls. Returns the stored event's id.
 */
export async function fanOutProviderEvent(
  db: HubDatabase,
  waiters: MessageWaiters,
  event: ReceivedProviderEvent,
  factoryIds: readonly string[],
): Promise<string> {
  const id = await db.transaction(async (tx) => {
    await lockAppends(tx);
    const [stored] = await tx
      .insert(providerEvents)
      .values(event)
      .returning({ id: providerEvents.id });
    if (!stored) throw new Error("storing a provider event returned no row");
    if (factoryIds.length > 0) {
      await tx.insert(factoryMessages).values(
        factoryIds.map((factoryId) => ({
          factoryId,
          kind: "event" as const,
          providerEventId: stored.id,
        })),
      );
    }
    return stored.id;
  });
  waiters.wake(factoryIds);
  return id;
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
    })
    .from(factoryMessages)
    .leftJoin(providerEvents, eq(providerEvents.id, factoryMessages.providerEventId))
    .where(
      and(eq(factoryMessages.factoryId, factoryId), gt(factoryMessages.position, sql`(${cursor})`)),
    )
    .orderBy(asc(factoryMessages.position))
    .limit(maxMessagesPerResponse);
  return rows.map(({ position, kind, event }): Message => {
    if (kind === "fellBehind" || !event) return { position: String(position), kind: "fellBehind" };
    return {
      position: String(position),
      kind,
      event: {
        id: event.id,
        provider: event.provider,
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
