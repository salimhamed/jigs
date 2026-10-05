import { Download, KeyRound, Link2, Trash2 } from "lucide-react";
import { data, Form, redirect } from "react-router";
import { isUuid, removeApp, setAssignments } from "../../src/apps.ts";
import { setPagerDutyWebhookSecret } from "../../src/pagerduty.ts";
import { setSlackScopes } from "../../src/slack.ts";
import { readApp } from "../apps.server.ts";
import { requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { button, input, quietButton, table } from "../components/ui.ts";
import type { Route } from "./+types/app.ts";

const notFound = () => data(null, { status: 404, statusText: "Not Found" });

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  const app = isUuid(params.id) ? await readApp(context, organizationId, params.id) : null;
  if (!app) throw notFound();
  return { isAdmin: role === "admin", app };
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const admin = await requireAdmin(context, request);
  if ("error" in admin) return admin;
  const { organizationId } = admin;
  if (!isUuid(params.id)) throw notFound();
  const form = await request.formData();
  switch (form.get("intent")) {
    case "remove":
      await removeApp(context.db, organizationId, params.id);
      return redirect("/apps");
    case "webhookSecret": {
      const secret = String(form.get("webhookSecret") ?? "").trim();
      if (!secret) return { error: "Enter the webhook subscription's signing secret." };
      const { db, config } = context;
      if (
        !(await setPagerDutyWebhookSecret(
          db,
          config.encryptionKey,
          organizationId,
          params.id,
          secret,
        ))
      ) {
        throw notFound();
      }
      return { message: "Saved the signing secret." };
    }
    case "scopes": {
      const saved = await setSlackScopes(
        context.db,
        organizationId,
        params.id,
        String(form.get("scopes") ?? ""),
      );
      if ("error" in saved) return saved;
      return { message: "Saved the scopes. Install the app again in each workspace." };
    }
    default: {
      const factoryIds = form.getAll("factoryId").map(String);
      if (!(await setAssignments(context.db, organizationId, params.id, factoryIds))) {
        throw notFound();
      }
      return { message: "Saved the factories." };
    }
  }
}

export default function AppPage({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { app, isAdmin } = loaderData;
  return (
    <div className="space-y-8">
      <ProviderApp app={app} isAdmin={isAdmin} />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Factories</h2>
        <p className="text-sm text-zinc-500">
          The factories that receive this app's provider events.
        </p>
        {app.factories.length === 0 ? (
          <p className="text-zinc-500">No factories yet.</p>
        ) : (
          <Form method="post" className="space-y-3">
            <div className="space-y-1">
              {app.factories.map((factory) => (
                <label key={factory.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="factoryId"
                    value={factory.id}
                    defaultChecked={factory.assigned}
                    disabled={!isAdmin}
                  />
                  {factory.name}
                </label>
              ))}
            </div>
            {isAdmin && (
              <button type="submit" name="intent" value="assign" className={button}>
                Save
              </button>
            )}
          </Form>
        )}
      </section>

      {isAdmin && (
        <Form
          method="post"
          onSubmit={(event) => {
            if (!confirm(`Remove ${app.name}? Its factories stop receiving its provider events.`)) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="remove" />
          <button type="submit" className={quietButton}>
            <Trash2 className="size-4" />
            Remove app
          </button>
        </Form>
      )}
    </div>
  );
}

type Loaded = Route.ComponentProps["loaderData"]["app"];

function ProviderApp({ app, isAdmin }: { app: Loaded; isAdmin: boolean }) {
  switch (app.provider) {
    case "github":
      return <GitHubApp app={app} isAdmin={isAdmin} />;
    case "linear":
      return <LinearApp app={app} isAdmin={isAdmin} />;
    case "slack":
      return <SlackApp app={app} isAdmin={isAdmin} />;
    case "pagerduty":
      return <PagerDutyApp app={app} isAdmin={isAdmin} />;
    default: {
      const unknown: never = app;
      throw new Error(`Unknown provider ${(unknown as Loaded).provider}`);
    }
  }
}

function GitHubApp({
  app,
  isAdmin,
}: {
  app: Extract<Loaded, { provider: "github" }>;
  isAdmin: boolean;
}) {
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{app.name}</h1>
        <p className="text-sm text-zinc-500">
          GitHub App {app.appId}, client ID {app.clientId}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">On GitHub</h2>
        <p className="text-sm">In the App's settings on GitHub, set:</p>
        <ul className="space-y-1 text-sm">
          <Setting label="Webhook URL" value={app.webhookUrl} />
          <Setting label="Setup URL" value={app.setupUrl} />
        </ul>
        <p className="text-sm">
          Keep the webhook <strong>Active</strong>, turn on <strong>Redirect on update</strong> and
          leave <strong>Request user authorization (OAuth) during installation</strong> off.
        </p>
        <p className="text-sm">
          Under <strong>Repository permissions</strong>, grant <strong>Contents</strong>,{" "}
          <strong>Pull requests</strong> and <strong>Issues</strong> read and write, and{" "}
          <strong>Metadata</strong>, <strong>Checks</strong> and <strong>Commit statuses</strong>{" "}
          read. Factories push, open, comment on and merge pull requests, create their labels, and
          read CI with them.
        </p>
        <p className="text-sm">
          Under <strong>Subscribe to events</strong>, choose <strong>Pull request</strong>,{" "}
          <strong>Pull request review</strong>, <strong>Pull request review comment</strong>,{" "}
          <strong>Issue comment</strong>, <strong>Check suite</strong> and <strong>Status</strong>.
          These wake the factory runs waiting on a pull request.
        </p>
        <p className="text-sm">
          Under <strong>Where can this GitHub App be installed?</strong> choose{" "}
          <strong>Only on this account</strong>. Otherwise anyone can install it, and their events
          reach your factories.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Installations</h2>
        {app.installations.length === 0 ? (
          <p className="text-zinc-500">Not installed anywhere yet.</p>
        ) : (
          <table className={table}>
            <thead className="text-zinc-500">
              <tr>
                <th>Account</th>
                <th>Installation</th>
              </tr>
            </thead>
            <tbody>
              {app.installations.map((installation) => (
                <tr
                  key={installation.externalId}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td>{installation.account}</td>
                  <td className="tabular-nums">{installation.externalId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {isAdmin && (
          <a href={app.installUrl} className={button}>
            <Download className="size-4" />
            Install on GitHub
          </a>
        )}
      </section>
    </>
  );
}

function LinearApp({
  app,
  isAdmin,
}: {
  app: Extract<Loaded, { provider: "linear" }>;
  isAdmin: boolean;
}) {
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{app.name}</h1>
        <p className="text-sm text-zinc-500">Linear app, client ID {app.clientId}</p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">In Linear</h2>
        <p className="text-sm">In the app's settings in Linear, set:</p>
        <ul className="space-y-1 text-sm">
          <Setting label="Callback URL" value={app.callbackUrl} />
          <Setting label="Webhook URL" value={app.webhookUrl} />
        </ul>
        <p className="text-sm">
          Turn on <strong>Webhooks</strong> and choose <strong>Agent session events</strong> and{" "}
          <strong>Comments</strong>. Leave the app private to your workspace unless other workspaces
          should connect to it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Workspaces</h2>
        {app.workspaces.length === 0 ? (
          <p className="text-zinc-500">No workspace connected yet.</p>
        ) : (
          <table className={table}>
            <thead className="text-zinc-500">
              <tr>
                <th>Workspace</th>
                <th>URL key</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {app.workspaces.map((workspace) => (
                <tr
                  key={workspace.externalId}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td>{workspace.name}</td>
                  <td>{workspace.urlKey}</td>
                  <td>
                    {workspace.failure === null ? (
                      "Connected"
                    ) : (
                      <span className="text-red-600 dark:text-red-400">
                        Connect again: {workspace.failure}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {isAdmin && (
          <>
            <p className="text-sm text-zinc-500">
              A Linear workspace admin approves the app for their workspace. Connect a workspace
              again to fix one that stopped working.
            </p>
            <a href={app.connectUrl} className={button}>
              <Link2 className="size-4" />
              Connect a Linear workspace
            </a>
          </>
        )}
      </section>
    </>
  );
}

function SlackApp({
  app,
  isAdmin,
}: {
  app: Extract<Loaded, { provider: "slack" }>;
  isAdmin: boolean;
}) {
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{app.name}</h1>
        <p className="text-sm text-zinc-500">
          Slack app {app.appId}, client ID {app.clientId}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">In Slack</h2>
        <p className="text-sm">
          In the app's settings at api.slack.com/apps, leave <strong>Socket Mode</strong> off, then
          set:
        </p>
        <ul className="space-y-1 text-sm">
          <Setting label="Request URL" value={app.requestUrl} />
          <Setting label="Redirect URL" value={app.redirectUrl} />
        </ul>
        <p className="text-sm">
          The Request URL goes under <strong>Event Subscriptions</strong>, with these bot events:{" "}
          {app.events.map((event, index) => (
            <span key={event}>
              {index > 0 && ", "}
              <code>{event}</code>
            </span>
          ))}
          . The Redirect URL goes under <strong>OAuth &amp; Permissions</strong>, where token
          rotation stays off. Invite the bot to each channel factories should hear.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Bot scopes</h2>
        <p className="text-sm text-zinc-500">
          What installing asks a workspace for: every scope jigs uses, plus any a factory's config
          adds.
        </p>
        <Form method="post" className="max-w-xl space-y-2">
          <textarea
            name="scopes"
            rows={3}
            required
            readOnly={!isAdmin}
            defaultValue={app.scopes.join(", ")}
            className={`${input} w-full font-mono`}
          />
          {isAdmin && (
            <button type="submit" name="intent" value="scopes" className={button}>
              Save
            </button>
          )}
        </Form>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Workspaces</h2>
        {app.workspaces.length === 0 ? (
          <p className="text-zinc-500">Not installed in a workspace yet.</p>
        ) : (
          <table className={table}>
            <thead className="text-zinc-500">
              <tr>
                <th>Workspace</th>
                <th>Team ID</th>
                <th>Granted scopes</th>
              </tr>
            </thead>
            <tbody>
              {app.workspaces.map((workspace) => (
                <tr
                  key={workspace.externalId}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td>{workspace.name}</td>
                  <td>{workspace.externalId}</td>
                  <td className="font-mono text-xs">{workspace.scopes.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {isAdmin && (
          <>
            <p className="text-sm text-zinc-500">
              Install the app again after changing its scopes.
            </p>
            <a href={app.installUrl} className={button}>
              <Download className="size-4" />
              Add to Slack
            </a>
          </>
        )}
      </section>
    </>
  );
}

function PagerDutyApp({
  app,
  isAdmin,
}: {
  app: Extract<Loaded, { provider: "pagerduty" }>;
  isAdmin: boolean;
}) {
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{app.name}</h1>
        <p className="text-sm text-zinc-500">
          PagerDuty connection, client ID {app.clientId}, acting as the app in{" "}
          {app.accounts.map((account) => `${account.subdomain} (${account.region})`).join(", ")}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">In PagerDuty</h2>
        <p className="text-sm">
          In the app's Scoped OAuth settings, grant these scopes:{" "}
          {app.scopes.map((scope, index) => (
            <span key={scope}>
              {index > 0 && ", "}
              <code>{scope}</code>
            </span>
          ))}
          .
        </p>
        <ul className="space-y-1 text-sm">
          <Setting label="Webhook URL" value={app.webhookUrl} />
        </ul>
        <p className="text-sm">
          Under Integrations, Generic Webhooks (v3), add a subscription delivering to the Webhook
          URL, on the account or on the services and teams factories watch, with these event types:{" "}
          {app.eventTypes.map((type, index) => (
            <span key={type}>
              {index > 0 && ", "}
              <code>{type}</code>
            </span>
          ))}
          . Then enter its signing secret here.
        </p>
        {isAdmin && (
          <Form method="post" className="flex max-w-xl flex-wrap items-end gap-2">
            <label className="flex grow flex-col gap-1 text-sm">
              Webhook signing secret
              <input
                name="webhookSecret"
                type="password"
                required
                autoComplete="off"
                placeholder={app.webhookSecretSet ? "Set; enter a new one to replace it" : ""}
                className={input}
              />
            </label>
            <button type="submit" name="intent" value="webhookSecret" className={button}>
              <KeyRound className="size-4" />
              Save
            </button>
          </Form>
        )}
        {!app.webhookSecretSet && (
          <p className="text-sm text-red-600 dark:text-red-400">
            No signing secret yet, so the hub refuses this connection's webhooks.
          </p>
        )}
      </section>
    </>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="w-28 text-zinc-500">{label}</span>
      <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-900">{value}</code>
      <CopyButton text={value} label={label} />
    </li>
  );
}
