import { AlertTriangle, Download, KeyRound, Link2, Save, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { data, Form, Link, redirect } from "react-router";
import { isUuid, removeApp, renameApp, setInstallationName } from "../../src/apps.ts";
import { setPagerDutyFrom, setPagerDutyWebhookSecret } from "../../src/pagerduty.ts";
import { providerNames } from "../../src/provider-names.ts";
import { setSlackScopes } from "../../src/slack.ts";
import { readApp } from "../apps.server.ts";
import { requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { ConfirmForm } from "../components/confirm-form.tsx";
import { Hint } from "../components/hint.tsx";
import { Card, Details, PageHeader, UrlRow } from "../components/page.tsx";
import { TimeAgo } from "../components/time.tsx";
import {
  button,
  card,
  dangerButton,
  errorText,
  external,
  input,
  link,
  quietButton,
  table,
  warningText,
} from "../components/ui.ts";
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
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const { db, config } = context;
  switch (form.get("intent")) {
    case "remove":
      await removeApp(db, organizationId, params.id);
      return redirect("/apps");
    case "rename": {
      const renamed = await renameApp(db, organizationId, params.id, field("name"));
      if ("error" in renamed) return renamed;
      return { message: `Renamed the app ${renamed.name}.` };
    }
    case "webhookSecret": {
      const secret = field("webhookSecret");
      if (!secret) return { error: "Enter the webhook subscription's signing secret." };
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
    case "installationName": {
      const named = await setInstallationName(
        db,
        organizationId,
        params.id,
        field("installationId"),
        field("installationName"),
      );
      if ("error" in named) return named;
      return { message: `Named the installation ${named.installationName}.` };
    }
    case "from": {
      const saved = await setPagerDutyFrom(
        db,
        config.encryptionKey,
        organizationId,
        params.id,
        field("from"),
      );
      if ("error" in saved) return saved;
      return { message: `Factories now make changes as ${saved.from}.` };
    }
    case "scopes": {
      const saved = await setSlackScopes(db, organizationId, params.id, field("scopes"));
      if ("error" in saved) return saved;
      return { message: "Saved the scopes. Install the app again in each workspace." };
    }
    default:
      throw notFound();
  }
}

type Loaded = Route.ComponentProps["loaderData"]["app"];
type AppOf<P extends Loaded["provider"]> = Extract<Loaded, { provider: P }>;

const providerTitles: Record<Loaded["provider"], string> = {
  github: "GitHub App",
  linear: "Linear app",
  slack: "Slack app",
  pagerduty: "PagerDuty app",
};

export default function AppPage({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { app, isAdmin } = loaderData;
  const provider = providerNames[app.provider];
  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-3">
        <PageHeader
          title={
            <>
              {app.name}
              <span className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-sm font-normal text-zinc-500 dark:border-zinc-700">
                {providerTitles[app.provider]}
              </span>
            </>
          }
          parent={{ to: "/apps", label: "Apps" }}
        />
        <Details items={providerIds(app)} />
      </div>
      <ProviderSections app={app} isAdmin={isAdmin} />

      <Card
        title="Factories"
        description="Factories connected to this app receive its events and can act through it. Connect or disconnect factories from each factory's page."
      >
        {app.factories.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Not connected to any factory yet. Connect it from a{" "}
            <Link to="/factories" className={link}>
              factory's page
            </Link>
            .
          </p>
        ) : (
          <div className={`${card} overflow-x-auto`}>
            <table className={table}>
              <thead>
                <tr>
                  <th>Factory</th>
                  <th>Last seen</th>
                  <th>Last event from this app</th>
                </tr>
              </thead>
              <tbody>
                {app.factories.map((factory) => (
                  <tr key={factory.id}>
                    <td>
                      <Link to={`/factories/${factory.id}`} className={link}>
                        {factory.name}
                      </Link>
                    </td>
                    <td>{factory.lastSeenAt ? <TimeAgo iso={factory.lastSeenAt} /> : "never"}</td>
                    <td>
                      {factory.lastEventAt ? (
                        <TimeAgo iso={factory.lastEventAt} />
                      ) : (
                        <span className="text-zinc-500">No events yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {isAdmin && (
        <Card title="Name">
          <Form method="post" className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <input
                name="name"
                required
                defaultValue={app.name}
                aria-label="Name"
                className={`${input} min-w-64`}
              />
              <button type="submit" name="intent" value="rename" className={button}>
                <Save className="size-4" />
                Save
              </button>
            </div>
            <p className="text-sm text-zinc-500">{nameHints[app.provider]}</p>
          </Form>
        </Card>
      )}

      {isAdmin && (
        <Card danger>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-xl text-sm">
              Removes this app from the hub. Factories connected to it stop receiving its events and
              can no longer act through it. The app itself isn't deleted from {provider}; do that on{" "}
              {provider} if you want.
            </p>
            <ConfirmForm
              fields={{ intent: "remove" }}
              title={`Remove ${app.name}?`}
              body="The hub forgets its credentials and installations. Factories connected to it stop receiving its events and can no longer act through it. Events already received stay in their logs."
              confirmLabel="Remove app"
              destructive
              className={dangerButton}
            >
              <Trash2 className="size-4" />
              Remove app
            </ConfirmForm>
          </div>
        </Card>
      )}
    </div>
  );
}

function providerIds(app: Loaded) {
  const clientId = { label: "Client ID", value: app.clientId, className: "font-mono" };
  switch (app.provider) {
    case "github":
      return [
        { label: "App ID", value: app.appId, className: "font-mono" },
        { label: "Slug", value: app.slug, className: "font-mono" },
        clientId,
      ];
    case "slack":
      return [{ label: "App ID", value: app.appId, className: "font-mono" }, clientId];
    default:
      return [clientId];
  }
}

const nameHints: Record<Loaded["provider"], string> = {
  github: "Only people see this name. Renaming it doesn't change the App on GitHub.",
  linear:
    "Match the app's name in Linear: people @mention it by that name, and agents are told it is their own. You can rename the app in Linear's settings any time. Running factories pick up a new name when they next get a Linear token; restart a factory to apply it at once.",
  slack:
    "Factories see this as the bot's name from their next Slack token; restart a factory to apply it at once. Renaming it doesn't change the app in Slack.",
  pagerduty: "Only people see this name. Renaming it doesn't change anything in PagerDuty.",
};

function ProviderSections({ app, isAdmin }: { app: Loaded; isAdmin: boolean }) {
  switch (app.provider) {
    case "github":
      return <GitHubSections app={app} isAdmin={isAdmin} />;
    case "linear":
      return <LinearSections app={app} isAdmin={isAdmin} />;
    case "slack":
      return <SlackSections app={app} isAdmin={isAdmin} />;
    case "pagerduty":
      return <PagerDutySections app={app} isAdmin={isAdmin} />;
    default: {
      const unknown: never = app;
      throw new Error(`Unknown provider ${(unknown as Loaded).provider}`);
    }
  }
}

const shortName = (
  <>
    Give each one a short name, such as <code>acme</code>.
  </>
);

function GitHubSections({ app, isAdmin }: { app: AppOf<"github">; isAdmin: boolean }) {
  return (
    <>
      <ProviderSettings
        provider="GitHub"
        description={
          <>
            In the App's settings on GitHub: <strong>Settings</strong> →{" "}
            <strong>Developer settings</strong> → <strong>GitHub Apps</strong> → the App.
          </>
        }
        urls={[
          {
            label: "Webhook URL",
            value: app.webhookUrl,
            where: (
              <>
                <strong>General</strong>, under <strong>Webhook</strong>.
              </>
            ),
          },
          {
            label: "Setup URL",
            value: app.setupUrl,
            where: (
              <>
                <strong>General</strong>, under <strong>Post installation</strong>.
              </>
            ),
          },
        ]}
        settings={[
          [
            "Webhook",
            <>
              <strong>Active</strong> on, <strong>SSL verification</strong> enabled
            </>,
          ],
          ["Redirect on update", "On; it is off by default"],
          ["Callback URL", "Leave empty"],
          ["Request user authorization (OAuth) during installation", "Off"],
          [
            "Repository permissions",
            <>
              <strong>Contents</strong>, <strong>Pull requests</strong>, <strong>Issues</strong>:
              Read and write · <strong>Metadata</strong>, <strong>Checks</strong>,{" "}
              <strong>Commit statuses</strong>: Read-only · every other: No access. Factories push,
              open, comment on and merge pull requests, create their labels, and read CI with them.
            </>,
          ],
          [
            "Subscribe to events",
            <>
              <strong>Pull request</strong>, <strong>Pull request review</strong>,{" "}
              <strong>Pull request review comment</strong>, <strong>Issue comment</strong>,{" "}
              <strong>Check suite</strong>,{" "}
              <strong className={warningText}>Status (easy to miss)</strong>. These wake the factory
              runs waiting on a pull request.
            </>,
          ],
          [
            "Where can this GitHub App be installed?",
            <>
              <strong>Only on this account</strong>. Otherwise anyone can install it, and their
              events reach your factories.
            </>,
          ],
        ]}
      />
      <InstallationsCard
        title="Installations"
        description={
          <>
            The GitHub accounts this App is installed on. {shortName} Your factory code uses that
            name to choose which account to work in.
          </>
        }
        action={
          isAdmin && (
            <a href={app.installUrl} className={button}>
              <Download className="size-4" />
              Install on GitHub
            </a>
          )
        }
        empty="Not installed anywhere yet."
        head={
          <>
            <th>Account</th>
            <th>GitHub installation</th>
          </>
        }
        rows={app.installations.map((installation) => ({
          installation,
          cells: (
            <>
              <td>{installation.account}</td>
              <td className="tabular-nums">{installation.externalId}</td>
            </>
          ),
        }))}
        isAdmin={isAdmin}
      />
    </>
  );
}

function LinearSections({ app, isAdmin }: { app: AppOf<"linear">; isAdmin: boolean }) {
  return (
    <>
      <ProviderSettings
        provider="Linear"
        description={
          <>
            In Linear: <strong>Settings</strong> → <strong>API</strong> →{" "}
            <strong>OAuth applications</strong> → the app. Replace the hub address you entered when
            creating it.
          </>
        }
        urls={[
          {
            label: "Redirect URI",
            value: app.callbackUrl,
            where: (
              <>
                Under <strong>Redirect URIs</strong>.
              </>
            ),
          },
          {
            label: "Webhook URL",
            value: app.webhookUrl,
            where: (
              <>
                Under <strong>Webhooks</strong>.
              </>
            ),
          },
        ]}
        settings={[
          ["Webhooks", "On"],
          ["Data change events", <strong key="comments">Comments</strong>],
          ["App events", <strong key="sessions">Agent session events</strong>],
          ["Every other event", "Off"],
          ["Client credentials", "Off"],
          ["Public", "Off, unless other workspaces should connect to the app"],
        ]}
      />
      <InstallationsCard
        title="Workspaces"
        description={
          <>
            The Linear workspaces connected to this app. {shortName} Your factory code uses that
            name to choose which workspace to work in. A Linear workspace admin approves the app for
            their workspace. Connect a workspace again to fix one that stopped working.
          </>
        }
        action={
          isAdmin && (
            <a href={app.connectUrl} className={button}>
              <Link2 className="size-4" />
              Connect a Linear workspace
            </a>
          )
        }
        empty="No workspace connected yet."
        head={
          <>
            <th>Workspace</th>
            <th>URL key</th>
            <th>Status</th>
          </>
        }
        rows={app.workspaces.map((workspace) => ({
          installation: workspace,
          cells: (
            <>
              <td>{workspace.name}</td>
              <td>{workspace.urlKey}</td>
              <td>
                {workspace.failure === null ? (
                  "Connected"
                ) : (
                  <span className={errorText}>Connect again: {workspace.failure}</span>
                )}
              </td>
            </>
          ),
        }))}
        isAdmin={isAdmin}
      />
    </>
  );
}

function SlackSections({ app, isAdmin }: { app: AppOf<"slack">; isAdmin: boolean }) {
  return (
    <>
      <ProviderSettings
        provider="Slack"
        description={
          <>
            In the app's settings at{" "}
            <a href="https://api.slack.com/apps" {...external} className={link}>
              api.slack.com/apps
            </a>
            .
          </>
        }
        urls={[
          {
            label: "Request URL",
            value: app.requestUrl,
            where: (
              <>
                <strong>Event Subscriptions</strong>, with <strong>Enable Events</strong> on.
              </>
            ),
          },
          {
            label: "Redirect URL",
            value: app.redirectUrl,
            where: (
              <>
                <strong>OAuth &amp; Permissions</strong>, under <strong>Redirect URLs</strong>.{" "}
                <span className={warningText}>
                  Click <strong>Save URLs</strong> before installing, or the install fails with{" "}
                  <code>redirect_uri did not match</code>.
                </span>
              </>
            ),
          },
        ]}
        settings={[
          ["Socket Mode", "Off, or Slack never sends events to the Request URL"],
          ["Subscribe to bot events", <Codes key="events" values={app.events} />],
          ["Token rotation", "Off"],
          [
            "Channels",
            <>
              Invite the bot to each channel factories should hear: <code>/invite @bot-name</code>
            </>,
          ],
        ]}
      />
      <Card
        title="Bot scopes"
        description="What installing asks a workspace for: every scope jigs uses, which stay, plus any a factory's own Slack calls need."
      >
        <Form method="post" className="space-y-2">
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
              <Save className="size-4" />
              Save
            </button>
          )}
        </Form>
      </Card>
      <InstallationsCard
        title="Workspaces"
        description={
          <>
            The Slack workspaces this app is installed in. {shortName} Your factory code uses that
            name to choose which workspace to work in. Install the app again after changing its
            scopes, here rather than from Slack's reinstall banner, so the hub gets the new token.
          </>
        }
        action={
          isAdmin && (
            <a href={app.installUrl} className={button}>
              <Download className="size-4" />
              Add to Slack
            </a>
          )
        }
        empty="Not installed in a workspace yet. If a workspace admin must approve the app, choose Add to Slack again once they have."
        head={
          <>
            <th>Workspace</th>
            <th>Team ID</th>
            <th>
              <Hint
                label="Granted scopes"
                tip="What the workspace approved when the app was installed."
              />
            </th>
          </>
        }
        rows={app.workspaces.map((workspace) => ({
          installation: workspace,
          cells: (
            <>
              <td>{workspace.name}</td>
              <td>{workspace.externalId}</td>
              <td className="font-mono text-xs">{workspace.scopes.join(", ")}</td>
            </>
          ),
        }))}
        isAdmin={isAdmin}
      />
    </>
  );
}

function PagerDutySections({ app, isAdmin }: { app: AppOf<"pagerduty">; isAdmin: boolean }) {
  return (
    <>
      {!app.webhookSecretSet && (
        <section
          className="space-y-3 rounded-lg border border-amber-400 p-5 dark:border-amber-700"
          aria-label="Missing signing secret"
        >
          <h2 className={`flex items-center gap-2 font-semibold ${warningText}`}>
            <AlertTriangle className="size-4" />
            No webhook signing secret yet
          </h2>
          <p className="text-sm">
            The hub refuses this app's webhooks until you enter one. PagerDuty shows the secret
            once, right after you create the webhook subscription described below; if you missed it,
            create the subscription again.
          </p>
          {isAdmin && <WebhookSecretForm replacing={false} />}
        </section>
      )}
      <ProviderSettings
        provider="PagerDuty"
        description={
          <>
            In PagerDuty, under <strong>Integrations</strong>.
          </>
        }
        urls={[
          {
            label: "Webhook URL",
            value: app.webhookUrl,
            where: (
              <>
                <strong>Integrations</strong> → <strong>Generic Webhooks (v3)</strong>: add a
                subscription delivering here.
              </>
            ),
          },
        ]}
        settings={[
          [
            "App scopes",
            <>
              Under <strong>App Registration</strong>, <strong>Scoped OAuth</strong>:{" "}
              <Codes values={app.scopes} />
            </>,
          ],
          ["Subscription scope", "The account, or the services and teams factories watch"],
          ["Event subscription", <Codes key="types" values={app.eventTypes} />],
        ]}
      >
        {app.webhookSecretSet && isAdmin && <WebhookSecretForm replacing />}
      </ProviderSettings>
      <InstallationsCard
        title="Account"
        description={
          <>
            The PagerDuty account this app connects to. Give it a short name, such as{" "}
            <code>acme</code>. Your factory code uses that name to refer to it. PagerDuty records
            every change, such as a note, as one of the account's users: the From user. The hub
            checks the account has a user with that email.
          </>
        }
        head={
          <>
            <th>Subdomain</th>
            <th>Region</th>
            <th>From</th>
          </>
        }
        empty="No account yet."
        rows={app.accounts.map((account) => ({
          installation: account,
          cells: (
            <>
              <td>{account.subdomain}</td>
              <td>{account.region}</td>
              <td>
                {isAdmin ? (
                  <Form method="post" className="flex items-center gap-2">
                    <input
                      name="from"
                      type="email"
                      required
                      defaultValue={account.from}
                      aria-label="From email"
                      className={input}
                    />
                    <button type="submit" name="intent" value="from" className={quietButton}>
                      <Save className="size-4" />
                      Save
                    </button>
                  </Form>
                ) : (
                  account.from
                )}
              </td>
            </>
          ),
        }))}
        isAdmin={isAdmin}
      />
    </>
  );
}

function WebhookSecretForm({ replacing }: { replacing: boolean }) {
  return (
    <Form method="post" className="flex flex-wrap items-end gap-2">
      <label className="flex grow flex-col gap-1 text-sm">
        Webhook signing secret
        <input
          name="webhookSecret"
          type="password"
          required
          autoComplete="off"
          placeholder={replacing ? "Set; enter a new one to replace it" : ""}
          className={input}
        />
      </label>
      <button type="submit" name="intent" value="webhookSecret" className={button}>
        <KeyRound className="size-4" />
        Save
      </button>
    </Form>
  );
}

/** What to set on the provider: each URL to copy and where it goes, then every other setting. */
function ProviderSettings({
  provider,
  description,
  urls,
  settings,
  children,
}: {
  provider: string;
  description: ReactNode;
  urls: { label: string; value: string; where: ReactNode }[];
  settings: [string, ReactNode][];
  children?: ReactNode;
}) {
  return (
    <Card title={`Set these on ${provider}`} description={description}>
      <div className="space-y-4">
        {urls.map(({ label, value, where }) => (
          <UrlRow key={label} label={label} value={value}>
            {where}
          </UrlRow>
        ))}
      </div>
      <dl className="divide-y divide-zinc-200 border-t border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {settings.map(([label, value]) => (
          <div key={label} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[16rem_1fr]">
            <dt className="font-semibold">{label}</dt>
            <dd className="text-zinc-600 dark:text-zinc-400">{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </Card>
  );
}

function Codes({ values }: { values: readonly string[] }) {
  return values.map((value, index) => (
    <span key={value}>
      {index > 0 && ", "}
      <code>{value}</code>
    </span>
  ));
}

type Installation = { id: string; installationName: string | null };

/** Where the app is installed, each with its installation name first. */
function InstallationsCard({
  title,
  description,
  action,
  empty,
  head,
  rows,
  isAdmin,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  empty: string;
  /** The header cells after the installation name's. */
  head: ReactNode;
  /** Each installation, with its cells after the installation name's. */
  rows: { installation: Installation; cells: ReactNode }[];
  isAdmin: boolean;
}) {
  return (
    <Card title={title} description={description} action={action}>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">{empty}</p>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className={table}>
            <thead>
              <tr>
                <th>
                  <Hint
                    label="Installation name"
                    tip="The short name your factory code uses for this installation."
                  />
                </th>
                {head}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ installation, cells }) => (
                <tr key={installation.id}>
                  <td>
                    <InstallationName installation={installation} isAdmin={isAdmin} />
                  </td>
                  {cells}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** An installation's name, which factories use for it, with a form to set it for admins. */
function InstallationName({
  installation,
  isAdmin,
}: {
  installation: Installation;
  isAdmin: boolean;
}) {
  if (!isAdmin) {
    return installation.installationName ?? <span className={warningText}>Needs a name</span>;
  }
  return (
    <Form method="post" className="flex items-center gap-2">
      <input type="hidden" name="installationId" value={installation.id} />
      <input
        name="installationName"
        required
        pattern="[a-z][a-z0-9\-]*"
        title="Lowercase letters, digits and hyphens, starting with a letter"
        defaultValue={installation.installationName ?? ""}
        placeholder="Needs a name"
        aria-label="Installation name"
        className={`${input} font-mono ${
          installation.installationName === null
            ? "border-amber-500 placeholder:text-amber-600 dark:border-amber-600 dark:placeholder:text-amber-400"
            : ""
        }`}
      />
      <button type="submit" name="intent" value="installationName" className={quietButton}>
        <Save className="size-4" />
        Save
      </button>
    </Form>
  );
}
