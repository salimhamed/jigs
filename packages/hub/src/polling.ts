import type { Provider } from "@jigs-ai/hub-protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { App, Installation } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps, installations, pollMarkers } from "./db/schema.ts";
import { fanOutProviderEvent, type MessageWaiters } from "./messages.ts";

const MINUTE_MS = 60 * 1000;

/** An event a poller made, named and shaped like the provider's own. */
export interface PolledEvent {
  name: string;
  payload: unknown;
  /** Names the fact the event reports, so it is sent once however often it is read. */
  dedupeKey: string;
}

/**
 * Reads what changed on a provider for one installation since its marker,
 * where the provider sends no webhook for it.
 */
export interface Poller {
  /** Keys the poller's markers. */
  name: string;
  provider: Provider;
  /** The events since `marker`, which is `null` on the first poll, and the marker for the next. */
  poll(
    app: App,
    installation: Installation,
    marker: string | null,
  ): Promise<{ events: PolledEvent[]; marker: string }>;
}

/** Poll one installation and send what the poller made, unless another hub is polling it now. */
export async function pollInstallation(
  db: HubDatabase,
  waiters: MessageWaiters,
  poller: Poller,
  app: App,
  installation: Installation,
): Promise<void> {
  const row = and(
    eq(pollMarkers.installationId, installation.id),
    eq(pollMarkers.poller, poller.name),
  );
  await db
    .insert(pollMarkers)
    .values({ installationId: installation.id, poller: poller.name })
    .onConflictDoNothing();
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .select()
      .from(pollMarkers)
      .where(row)
      .for("update", { skipLocked: true });
    if (!claimed) return;
    const { events, marker } = await poller.poll(app, installation, claimed.marker);
    for (const event of events) {
      await fanOutProviderEvent(db, waiters, {
        organizationId: app.organizationId,
        appId: app.id,
        installationId: installation.id,
        provider: poller.provider,
        origin: "hub",
        ...event,
      });
    }
    await tx.update(pollMarkers).set({ marker }).where(row);
  });
}

/** Run every poller over each installation of its provider that is not failing. */
export async function pollAll(
  db: HubDatabase,
  waiters: MessageWaiters,
  pollers: Poller[],
): Promise<void> {
  for (const poller of pollers) {
    const rows = await db
      .select({ app: apps, installation: installations })
      .from(installations)
      .innerJoin(apps, eq(apps.id, installations.appId))
      .where(and(eq(apps.provider, poller.provider), isNull(installations.failure)));
    for (const { app, installation } of rows) {
      await pollInstallation(db, waiters, poller, app, installation).catch((error) => {
        console.error(
          `[polling] ${poller.name} could not poll ${installation.account} for ${app.name}: ${String(error)}`,
        );
      });
    }
  }
}

/** Poll now and every minute until stopped. */
export function startPolling(
  db: HubDatabase,
  waiters: MessageWaiters,
  pollers: Poller[],
): { stop(): Promise<void> } {
  const run = () =>
    pollAll(db, waiters, pollers).catch((error) => {
      console.error(`[polling] could not poll: ${String(error)}`);
    });
  let running = run();
  const timer = setInterval(() => {
    running = running.then(run);
  }, MINUTE_MS);
  return {
    stop: () => {
      clearInterval(timer);
      return running;
    },
  };
}
