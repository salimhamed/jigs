import type { Provider } from "@jigs-ai/hub-protocol";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { HubDatabase, Transaction } from "./db/database.ts";
import { apps, assignments, factories, installations } from "./db/schema.ts";

export type App = typeof apps.$inferSelect;

export type Installation = typeof installations.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string from a URL can be a row's id. */
export const isUuid = (value: string) => UUID.test(value);

/** The provider's app with this id, or `null`; any string may come from a URL. */
export async function findApp(
  db: HubDatabase,
  provider: Provider,
  appId: string,
): Promise<App | null> {
  if (!isUuid(appId)) return null;
  return (
    (await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.provider, provider)),
    })) ?? null
  );
}

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

/** The apps assigned to a factory, each with where it is installed. */
export async function assignedApps(db: HubDatabase, factoryId: string) {
  const rows = await db
    .select({
      id: apps.id,
      provider: apps.provider,
      name: apps.name,
      account: installations.account,
      installationName: installations.installationName,
    })
    .from(assignments)
    .innerJoin(apps, eq(apps.id, assignments.appId))
    .leftJoin(installations, eq(installations.appId, apps.id))
    .where(eq(assignments.factoryId, factoryId))
    .orderBy(asc(apps.provider), asc(apps.name), asc(installations.account));
  const assigned = new Map<
    string,
    {
      id: string;
      provider: Provider;
      name: string;
      installations: { account: string; installationName: string | null }[];
    }
  >();
  for (const { id, provider, name, account, installationName } of rows) {
    const app = assigned.get(id) ?? { id, provider, name, installations: [] };
    assigned.set(id, app);
    if (account !== null) app.installations.push({ account, installationName });
  }
  return [...assigned.values()];
}

/** An installation as the hub records it. `secrets` are already encrypted. */
export interface InstallationValues {
  externalId: string;
  account: string;
  settings?: unknown;
  secrets?: string;
}

/** The app an installation belongs to. */
type InstallationOwner = Pick<App, "id" | "organizationId">;

/** Record where an app is installed, or update an installation it has, clearing any failure. */
export async function recordInstallation(
  db: HubDatabase | Transaction,
  app: InstallationOwner,
  installation: InstallationValues,
): Promise<void> {
  const { externalId, ...values } = installation;
  await db
    .insert(installations)
    .values({ appId: app.id, organizationId: app.organizationId, externalId, ...values })
    .onConflictDoUpdate({
      target: [installations.appId, installations.externalId],
      set: { ...values, failure: null },
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

/** An installation as the provider lists it. */
export interface Installed {
  externalId: string;
  account: string;
}

/**
 * Record every installation the provider lists. Installations it no longer
 * lists stay: only an uninstall event removes one, since a list read before
 * an install can arrive after it.
 */
export async function recordInstallations(
  db: HubDatabase | Transaction,
  app: InstallationOwner,
  installed: readonly Installed[],
): Promise<void> {
  if (installed.length === 0) return;
  await db
    .insert(installations)
    .values(installed.map((row) => ({ appId: app.id, organizationId: app.organizationId, ...row })))
    .onConflictDoUpdate({
      target: [installations.appId, installations.externalId],
      set: { account: sql`excluded.account` },
    });
}

const INSTALLATION_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Name one of an app's installations, the name factories use for it. Names are
 * unique within the Organization.
 */
export async function setInstallationName(
  db: HubDatabase,
  organizationId: string,
  appId: string,
  installationId: string,
  installationName: string,
): Promise<{ installationName: string } | { error: string }> {
  if (!INSTALLATION_NAME.test(installationName)) {
    return {
      error:
        "An installation name is lowercase letters, digits and hyphens, starting with a letter.",
    };
  }
  if (!isUuid(installationId)) return { error: "There is no such installation." };
  const named = await db
    .update(installations)
    .set({ installationName })
    .where(
      and(
        eq(installations.id, installationId),
        eq(installations.appId, appId),
        eq(installations.organizationId, organizationId),
      ),
    )
    .returning({ id: installations.id })
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) return null;
      throw error;
    });
  if (named === null) {
    return { error: `Another installation is already named ${installationName}.` };
  }
  if (named.length === 0) return { error: "There is no such installation." };
  return { installationName };
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  ((error as { code?: string }).code === "23505" || isUniqueViolation(error.cause));

/** The one installation of a provider's apps assigned to a factory that `where` matches, or the status and message to refuse with. */
export async function findAssignedInstallation(
  db: HubDatabase,
  factoryId: string,
  provider: Provider,
  where: SQL | undefined,
  wording: {
    /** The 404 message when nothing matches. */
    none: string;
    /** The 409 message when several match, before the list of them. */
    several: string;
  },
): Promise<{ app: App; installation: Installation } | { status: 404 | 409; error: string }> {
  const found = await db
    .select({ app: apps, installation: installations })
    .from(installations)
    .innerJoin(apps, eq(apps.id, installations.appId))
    .innerJoin(assignments, eq(assignments.appId, apps.id))
    .where(and(eq(assignments.factoryId, factoryId), eq(apps.provider, provider), where));
  const [first] = found;
  if (!first) return { status: 404, error: wording.none };
  if (found.length > 1) {
    const names = found
      .map((row) => `${row.app.name} (${row.installation.account})`)
      .sort()
      .join(", ");
    return { status: 409, error: `${wording.several}: ${names}.` };
  }
  return first;
}
