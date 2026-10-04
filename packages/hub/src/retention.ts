import { sql } from "drizzle-orm";
import type { HubDatabase } from "./db/database.ts";
import { lockAppends, type MessageWaiters } from "./messages.ts";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Delete messages older than the retention. A factory that loses a message it
 * had not confirmed gets one `fellBehind` message, unless one is already
 * waiting for it. Then delete the provider events no message refers to.
 */
export async function deleteExpiredMessages(
  db: HubDatabase,
  waiters: MessageWaiters,
  retentionDays: number,
): Promise<void> {
  const behind = await db.transaction(async (tx) => {
    await lockAppends(tx);
    const lost = await tx.execute<{ factory_id: string }>(sql`
      with deleted as (
        delete from factory_messages
        where created_at < now() - make_interval(days => ${retentionDays})
        returning factory_id, position
      )
      select distinct deleted.factory_id from deleted
      join factories on factories.id = deleted.factory_id
      where deleted.position > factories.cursor
    `);
    const factoryIds = lost.rows.map((row) => row.factory_id);
    const told =
      factoryIds.length === 0
        ? { rows: [] }
        : await tx.execute<{ factory_id: string }>(sql`
            insert into factory_messages (factory_id, kind)
            select factories.id, 'fellBehind' from factories
            where factories.id in ${factoryIds}
              and not exists (
                select from factory_messages
                where factory_id = factories.id
                  and kind = 'fellBehind'
                  and position > factories.cursor
              )
            returning factory_id
          `);
    await tx.execute(sql`
      delete from provider_events
      where not exists (select from factory_messages where provider_event_id = provider_events.id)
    `);
    return told.rows.map((row) => row.factory_id);
  });
  waiters.wake(behind);
}

/** Delete expired messages now and every hour until stopped. */
export function startRetention(
  db: HubDatabase,
  waiters: MessageWaiters,
  retentionDays: number,
): { stop(): Promise<void> } {
  const run = () =>
    deleteExpiredMessages(db, waiters, retentionDays).catch((error) => {
      console.error(`[retention] could not delete expired messages: ${String(error)}`);
    });
  let running = run();
  const timer = setInterval(() => {
    running = running.then(run);
  }, HOUR_MS);
  return {
    stop: () => {
      clearInterval(timer);
      return running;
    },
  };
}
