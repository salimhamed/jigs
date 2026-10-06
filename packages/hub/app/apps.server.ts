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

/** An Organization's apps, each with its installations and assigned factories. */
export async function listApps(context: AppLoadContext, organizationId: string) {
  const rows = await context.db.query.apps.findMany({
    columns: { id: true, provider: true, name: true },
    where: eq(apps.organizationId, organizationId),
    orderBy: [asc(apps.provider), asc(apps.name)],
  });
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
    .select({ appId: assignments.appId, factory: factories.name })
    .from(assignments)
    .innerJoin(factories, eq(factories.id, assignments.factoryId))
    .where(eq(factories.organizationId, organizationId))
    .orderBy(asc(factories.name));
  return rows.map((app) => ({
    ...app,
    installations: installed
      .filter((row) => row.appId === app.id)
      .map(({ account, installationName }) => ({ account, installationName })),
    factories: assigned.filter((row) => row.appId === app.id).map((row) => row.factory),
  }));
}

/** One app's page: what to set on the provider, its installations and assignments. */
export async function readApp(context: AppLoadContext, organizationId: string, appId: string) {
  const app = await context.db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
  });
  if (!app) return null;
  const { origin } = context.config.publicUrl;
  const [installed, organizationFactories] = await Promise.all([
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
      .select({ id: factories.id, name: factories.name, assigned: assignments.appId })
      .from(factories)
      .leftJoin(
        assignments,
        and(eq(assignments.factoryId, factories.id), eq(assignments.appId, app.id)),
      )
      .where(eq(factories.organizationId, organizationId))
      .orderBy(asc(factories.name)),
  ]);
  const common = {
    id: app.id,
    name: app.name,
    factories: organizationFactories.map((factory) => ({
      id: factory.id,
      name: factory.name,
      assigned: factory.assigned !== null,
    })),
  };
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
