import { pagerDutyScopes } from "@jigs-ai/hub-protocol";
import { and, asc, eq } from "drizzle-orm";
import type { AppLoadContext } from "react-router";
import { apps, assignments, factories, installations } from "../src/db/schema.ts";
import {
  type GitHubAppSettings,
  githubInstallUrl,
  githubSetupPath,
  githubWebhookPath,
} from "../src/github.ts";
import {
  type LinearWorkspaceSettings,
  linearCallbackPath,
  linearConnectPath,
  linearWebhookPath,
} from "../src/linear.ts";
import {
  hasPagerDutyWebhookSecret,
  type PagerDutyAccountSettings,
  pagerDutyEventTypes,
  pagerDutyWebhookPath,
} from "../src/pagerduty.ts";
import {
  type SlackAppSettings,
  type SlackWorkspaceSettings,
  slackBotEvents,
  slackCallbackPath,
  slackInstallPath,
  slackWebhookPath,
} from "../src/slack.ts";

/** An Organization's apps, by provider and name. */
export function listAppNames(context: AppLoadContext, organizationId: string) {
  return context.db.query.apps.findMany({
    columns: { id: true, provider: true, name: true },
    where: eq(apps.organizationId, organizationId),
    orderBy: [asc(apps.provider), asc(apps.name)],
  });
}

/** An Organization's apps, each with its installations and how many factories it is assigned to. */
export async function listApps(context: AppLoadContext, organizationId: string) {
  const rows = await listAppNames(context, organizationId);
  const installed = await context.db
    .select({
      appId: installations.appId,
      account: installations.account,
      installationName: installations.installationName,
    })
    .from(installations)
    .where(eq(installations.organizationId, organizationId))
    .orderBy(asc(installations.account));
  const assigned = await context.db
    .select({ appId: assignments.appId })
    .from(assignments)
    .innerJoin(apps, eq(apps.id, assignments.appId))
    .where(eq(apps.organizationId, organizationId));
  return rows.map((app) => ({
    ...app,
    installations: installed
      .filter((row) => row.appId === app.id)
      .map(({ account, installationName }) => ({ account, installationName })),
    factories: assigned.filter((row) => row.appId === app.id).length,
  }));
}

/** One app's page: what to set on the provider, its installations and the factories it is assigned to. */
export async function readApp(context: AppLoadContext, organizationId: string, appId: string) {
  const app = await context.db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
  });
  if (!app) return null;
  const { origin } = context.config.publicUrl;
  const [installed, assignedFactories] = await Promise.all([
    context.db
      .select({
        id: installations.id,
        installationName: installations.installationName,
        externalId: installations.externalId,
        account: installations.account,
        settings: installations.settings,
        failure: installations.failure,
      })
      .from(installations)
      .where(eq(installations.appId, app.id))
      .orderBy(asc(installations.account)),
    context.db
      .select({ id: factories.id, name: factories.name })
      .from(assignments)
      .innerJoin(factories, eq(factories.id, assignments.factoryId))
      .where(eq(assignments.appId, app.id))
      .orderBy(asc(factories.name)),
  ]);
  const common = { id: app.id, name: app.name, factories: assignedFactories };
  switch (app.provider) {
    case "linear":
      return {
        ...common,
        provider: "linear" as const,
        clientId: app.externalId,
        connectUrl: linearConnectPath(app.id),
        callbackUrl: `${origin}${linearCallbackPath(app.id)}`,
        webhookUrl: `${origin}${linearWebhookPath(app.id)}`,
        workspaces: installed.map((workspace) => ({
          id: workspace.id,
          installationName: workspace.installationName,
          externalId: workspace.externalId,
          urlKey: workspace.account,
          name: (workspace.settings as LinearWorkspaceSettings | null)?.name ?? workspace.account,
          failure: workspace.failure,
        })),
      };
    case "slack":
      return {
        ...common,
        provider: "slack" as const,
        appId: app.externalId,
        clientId: (app.settings as SlackAppSettings).clientId,
        scopes: (app.settings as SlackAppSettings).scopes,
        installUrl: slackInstallPath(app.id),
        redirectUrl: `${origin}${slackCallbackPath(app.id)}`,
        requestUrl: `${origin}${slackWebhookPath}`,
        events: [...slackBotEvents],
        workspaces: installed.map(({ id, installationName, externalId, account, settings }) => ({
          id,
          installationName,
          externalId,
          name: account,
          scopes: (settings as SlackWorkspaceSettings | null)?.scopes ?? [],
        })),
      };
    case "pagerduty":
      return {
        ...common,
        provider: "pagerduty" as const,
        clientId: app.externalId,
        webhookSecretSet: hasPagerDutyWebhookSecret(context.config.encryptionKey, app),
        webhookUrl: `${origin}${pagerDutyWebhookPath(app.id)}`,
        scopes: [...pagerDutyScopes],
        eventTypes: [...pagerDutyEventTypes],
        accounts: installed.map((account) => {
          const settings = account.settings as PagerDutyAccountSettings;
          return {
            id: account.id,
            installationName: account.installationName,
            externalId: account.externalId,
            subdomain: account.account,
            region: settings.region,
            from: settings.from,
          };
        }),
      };
    case "github":
      return {
        ...common,
        provider: "github" as const,
        appId: app.externalId,
        slug: (app.settings as GitHubAppSettings).slug,
        clientId: (app.settings as GitHubAppSettings).clientId,
        installUrl: githubInstallUrl(app),
        webhookUrl: `${origin}${githubWebhookPath}`,
        setupUrl: `${origin}${githubSetupPath(app.id)}`,
        installations: installed.map(({ id, installationName, externalId, account }) => ({
          id,
          installationName,
          externalId,
          account,
        })),
      };
    default:
      throw new Error(`Unknown provider ${app.provider satisfies never}`);
  }
}
