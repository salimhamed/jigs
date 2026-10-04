import { and, asc, eq } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { apps, assignments, factories, installations } from "../src/db/schema.ts";
import { type GitHubAppSettings, githubSetupPath, githubWebhookPath } from "../src/github.ts";

/** An Organization's apps, each with its installations and assigned factories. */
export async function listApps(context: AppLoadContext, organizationId: string) {
  const rows = await context.db.query.apps.findMany({
    columns: { id: true, provider: true, name: true },
    where: eq(apps.organizationId, organizationId),
    orderBy: [asc(apps.provider), asc(apps.name)],
  });
  const installed = await context.db
    .select({ appId: installations.appId, account: installations.account })
    .from(installations)
    .innerJoin(apps, eq(apps.id, installations.appId))
    .where(eq(apps.organizationId, organizationId))
    .orderBy(asc(installations.account));
  const assigned = await context.db
    .select({ appId: assignments.appId, factory: factories.name })
    .from(assignments)
    .innerJoin(factories, eq(factories.id, assignments.factoryId))
    .where(eq(factories.organizationId, organizationId))
    .orderBy(asc(factories.name));
  return rows.map((app) => ({
    ...app,
    installations: installed.filter((row) => row.appId === app.id).map((row) => row.account),
    factories: assigned.filter((row) => row.appId === app.id).map((row) => row.factory),
  }));
}

/** One app's page: what to set on the provider, its installations and assignments. */
export async function readApp(context: AppLoadContext, organizationId: string, appId: string) {
  const app = await context.db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
  });
  if (!app) return null;
  const settings = app.settings as GitHubAppSettings;
  const { origin } = context.config.publicUrl;
  const [installed, organizationFactories] = await Promise.all([
    context.db
      .select({ externalId: installations.externalId, account: installations.account })
      .from(installations)
      .where(eq(installations.appId, app.id))
      .orderBy(asc(installations.account)),
    context.db
      .select({ id: factories.id, name: factories.name, assigned: assignments.appId })
      .from(factories)
      .leftJoin(
        assignments,
        and(eq(assignments.factoryId, factories.id), eq(assignments.appId, app.id)),
      )
      .where(eq(factories.organizationId, organizationId))
      .orderBy(asc(factories.name)),
  ]);
  return {
    id: app.id,
    provider: app.provider,
    name: app.name,
    appId: app.externalId,
    slug: settings.slug,
    clientId: settings.clientId,
    webhookUrl: `${origin}${githubWebhookPath}`,
    setupUrl: `${origin}${githubSetupPath}`,
    installations: installed,
    factories: organizationFactories.map((factory) => ({
      id: factory.id,
      name: factory.name,
      assigned: factory.assigned !== null,
    })),
  };
}

/** The apps assigned to a factory. */
export async function assignedApps(context: AppLoadContext, factoryId: string) {
  return context.db
    .select({ id: apps.id, provider: apps.provider, name: apps.name })
    .from(assignments)
    .innerJoin(apps, eq(apps.id, assignments.appId))
    .where(eq(assignments.factoryId, factoryId))
    .orderBy(asc(apps.provider), asc(apps.name));
}
