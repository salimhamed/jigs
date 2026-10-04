import { and, eq, inArray, sql } from "drizzle-orm";
import type { HubDatabase } from "./db/database.ts";
import { apps, assignments, factories, installations } from "./db/schema.ts";

export type App = typeof apps.$inferSelect;

/** Remove an app with its installations and assignments. Its stored provider events stay. */
export async function removeApp(
  db: HubDatabase,
  organizationId: string,
  appId: string,
): Promise<void> {
  await db.delete(apps).where(and(eq(apps.id, appId), eq(apps.organizationId, organizationId)));
}

/**
 * Assign an app to exactly these factories of its Organization, unassigning
 * it from every other. Returns `false` if there is no such app.
 */
export async function setAssignments(
  db: HubDatabase,
  organizationId: string,
  appId: string,
  factoryIds: readonly string[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [app] = await tx
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.organizationId, organizationId)))
      .for("update");
    if (!app) return false;
    await tx.delete(assignments).where(eq(assignments.appId, appId));
    if (factoryIds.length > 0) {
      await tx.execute(sql`
        insert into ${assignments} (app_id, factory_id)
        select ${appId}, ${factories.id} from ${factories}
        where ${inArray(factories.id, [...factoryIds])}
          and ${factories.organizationId} = ${organizationId}
      `);
    }
    return true;
  });
}

/** Record where an app is installed, or update the account of an installation it has. */
export async function recordInstallation(
  db: HubDatabase,
  appId: string,
  externalId: string,
  account: string,
): Promise<void> {
  await db
    .insert(installations)
    .values({ appId, externalId, account })
    .onConflictDoUpdate({
      target: [installations.appId, installations.externalId],
      set: { account },
    });
}

/** Forget an installation the provider says is gone. */
export async function removeInstallation(
  db: HubDatabase,
  appId: string,
  externalId: string,
): Promise<void> {
  await db
    .delete(installations)
    .where(and(eq(installations.appId, appId), eq(installations.externalId, externalId)));
}
