import type { Provider } from "@jigs-ai/hub-protocol";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type HubDatabase, isUniqueViolation, type Transaction } from "./db/database.ts";
import { apps, assignments, factories, installations } from "./db/schema.ts";
import { providerNames } from "./provider-names.ts";

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
 * Rename an app. The name labels it on the hub; a Linear or Slack app's
 * factories also learn it as the app's own name with their next token.
 */
export async function renameApp(
  db: HubDatabase,
  organizationId: string,
  appId: string,
  name: string,
): Promise<{ name: string } | { error: string }> {
  if (!name) return { error: "Name the app." };
  const renamed = await db
    .update(apps)
    .set({ name })
    .where(and(eq(apps.id, appId), eq(apps.organizationId, organizationId)))
    .returning({ id: apps.id });
  if (renamed.length === 0) return { error: "There is no such app." };
  return { name };
}

/** Assign an app to a factory, so the factory receives its events. Both must be the Organization's. */
export async function assignApp(
  db: HubDatabase,
  organizationId: string,
  factoryId: string,
  appId: string,
): Promise<void> {
  await db.execute(sql`
    insert into ${assignments} (app_id, factory_id)
    select ${apps.id}, ${factories.id} from ${apps}, ${factories}
    where ${apps.id} = ${appId} and ${apps.organizationId} = ${organizationId}
      and ${factories.id} = ${factoryId} and ${factories.organizationId} = ${organizationId}
    on conflict do nothing
  `);
}

/** Stop a factory of the Organization receiving an app's events. */
export async function unassignApp(
  db: HubDatabase,
  organizationId: string,
  factoryId: string,
  appId: string,
): Promise<void> {
  await db
    .delete(assignments)
    .where(
      and(
        eq(assignments.appId, appId),
        eq(assignments.factoryId, factoryId),
        inArray(
          assignments.factoryId,
          db
            .select({ id: factories.id })
            .from(factories)
            .where(eq(factories.organizationId, organizationId)),
        ),
      ),
    );
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

/**
 * The installation of the provider named `installationName`, of an app
 * assigned to the factory, or the 404 to refuse with.
 */
export async function findNamedInstallation(
  db: HubDatabase,
  factoryId: string,
  provider: Provider,
  installationName: string,
): Promise<{ app: App; installation: Installation } | { status: 404; error: string }> {
  const [found] = await db
    .select({ app: apps, installation: installations })
    .from(installations)
    .innerJoin(apps, eq(apps.id, installations.appId))
    .innerJoin(assignments, eq(assignments.appId, apps.id))
    .innerJoin(factories, eq(factories.id, assignments.factoryId))
    .where(
      and(
        eq(assignments.factoryId, factoryId),
        eq(installations.organizationId, factories.organizationId),
        eq(apps.provider, provider),
        eq(installations.installationName, installationName),
      ),
    );
  return (
    found ?? {
      status: 404,
      error: `No ${providerNames[provider]} installation named ${installationName} is assigned to this factory.`,
    }
  );
}
