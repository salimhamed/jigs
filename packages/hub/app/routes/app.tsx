import { AlertTriangle, Download, KeyRound, Link2, Save, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { data, Form, Link, redirect } from "react-router";
import { isUuid, removeApp, renameApp, setInstallationName } from "../../src/apps.ts";
import { setPagerDutyFrom, setPagerDutyWebhookSecret } from "../../src/pagerduty.ts";
import { setSlackScopes } from "../../src/slack.ts";
import { readApp } from "../apps.server.ts";
import { requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { ConfirmForm } from "../components/confirm-form.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { Card, PageHeader } from "../components/page.tsx";
import { linearNameHint } from "../components/provider.tsx";
import {
  button,
  card,
  dangerButton,
  errorText,
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
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={
          <>
            {app.name}
            <span className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-sm font-normal text-zinc-500 dark:border-zinc-700">
              {providerTitles[app.provider]}
            </span>
          </>
        }
        subtitle={<ProviderIds app={app} />}
        parent={{ to: "/apps", label: "Apps" }}
      />
      <ProviderSections app={app} isAdmin={isAdmin} />

      <Card
        title="Factories"
        description="They receive this app's events and can ask for its tokens."
      >
        {app.factories.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Not assigned to any factory yet. Assign it from a{" "}
            <Link to="/factories" className={link}>
              factory's page
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm">
            {app.factories.map((factory) => (
              <li key={factory.id}>
                <Link
                  to={`/factories/${factory.id}`}
                  className={`${card} block px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900`}
                >
                  {factory.name}
                </Link>
              </li>
            ))}
          </ul>
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
            <p className="text-sm text-zinc-500">
              <NameHint app={app} />
            </p>
          </Form>
        </Card>
      )}

      {isAdmin && (
        <Card danger>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm">Its factories stop receiving its provider events.</p>
            <ConfirmForm
              fields={{ intent: "remove" }}
              question={`Remove ${app.name}? Its factories stop receiving its provider events.`}
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

function ProviderIds({ app }: { app: Loaded }) {
  switch (app.provider) {
    case "github":
      return `App ID ${app.appId}, slug ${app.slug}, client ID ${app.clientId}`;
    case "slack":
      return `App ID ${app.appId}, client ID ${app.clientId}`;
    default:
      return `Client ID ${app.clientId}`;
  }
}

function NameHint({ app }: { app: Loaded }) {
  switch (app.provider) {
    case "github":
      return `A label for people; GitHub never sees it. The App's slug stays ${app.slug}.`;
    case "linear":
      return (
        <>
          {linearNameHint} Running factories pick up a new name when they next get a Linear token;
          restart a factory to apply it at once.
        </>
      );
    case "slack":
      return "Factories see a new name with their next Slack token; restart a factory to apply it at once.";
    case "pagerduty":
      return "A label for people; PagerDuty never sees it.";
  }
}

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

function GitHubSections({ app, isAdmin }: { app: AppOf<"github">; isAdmin: boolean }) {
  return (
    <>
      <ProviderSettings
        provider="GitHub"
        description="In the App's settings on GitHub: Developer settings, GitHub Apps, then the App."
        urls={[
          { label: "Webhook URL", value: app.webhookUrl, where: "General, under Webhook." },
          { label: "Setup URL", value: app.setupUrl, where: "General, under Post installation." },
        ]}
        settings={[
          ["Webhook", "Active on, SSL verification enabled"],
          ["Redirect on update", "On; it is off by default"],
          ["Callback URL", "Leave empty"],
          ["Request user authorization (OAuth) during installation", "Off"],
          [
            "Repository permissions",
            <>
              Contents, Pull requests, Issues: read and write · Metadata, Checks, Commit statuses:
              read · every other: No access. Factories push, open, comment on and merge pull
              requests, create their labels, and read CI with them.
            </>,
          ],
          [
            "Subscribe to events",
            <>
              Pull request, Pull request review, Pull request review comment, Issue comment, Check
              suite, <span className={warningText}>Status (easy to miss)</span>. These wake the
              factory runs waiting on a pull request.
            </>,
          ],
          [
            "Where can this GitHub App be installed?",
            "Only on this account. Otherwise anyone can install it, and their events reach your factories.",
          ],
        ]}
      />
      <InstallationsCard
        title="Installations"
        action={
          isAdmin && (
            <a href={app.installUrl} className={button}>
              <Download className="size-4" />
              Install on GitHub
            </a>
          )
        }
        empty="Not installed anywhere yet."
        columns={["Account", "GitHub installation"]}
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
        description="In the app's settings in Linear: Settings, API, then the app. Replace the placeholders you entered when creating it."
        urls={[
          { label: "Redirect URI", value: app.callbackUrl, where: "Under Redirect URIs." },
          { label: "Webhook URL", value: app.webhookUrl, where: "Under Webhooks." },
        ]}
        settings={[
          ["Webhooks", "On"],
          ["Data change events", "Comments"],
          ["App events", "Agent session events"],
          ["Every other event", "Off"],
          ["Client credentials", "Off"],
          ["Public", "Off, unless other workspaces should connect to the app"],
        ]}
      />
      <InstallationsCard
        title="Workspaces"
        description="A Linear workspace admin approves the app for their workspace. Connect a workspace again to fix one that stopped working."
        action={
          isAdmin && (
            <a href={app.connectUrl} className={button}>
              <Link2 className="size-4" />
              Connect a Linear workspace
            </a>
          )
        }
        empty="No workspace connected yet."
        columns={["Workspace", "URL key", "Status"]}
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
        description="In the app's settings at api.slack.com/apps."
        urls={[
          {
            label: "Request URL",
            value: app.requestUrl,
            where: "Event Subscriptions, with Enable Events on.",
          },
          {
            label: "Redirect URL",
            value: app.redirectUrl,
            where: (
              <>
                OAuth &amp; Permissions, under Redirect URLs.{" "}
                <span className={warningText}>
                  Choose Save URLs before installing, or the install fails with "redirect_uri did
                  not match".
                </span>
              </>
            ),
          },
        ]}
        settings={[
          ["Socket Mode", "Off, or Slack never sends events to the Request URL"],
          ["Subscribe to bot events", <Codes key="events" values={app.events} />],
          ["Token rotation", "Off"],
          ["Channels", "Invite the bot to each channel factories should hear"],
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
        description="Install the app again after changing its scopes, here rather than from Slack's reinstall banner, so the hub gets the new token."
        action={
          isAdmin && (
            <a href={app.installUrl} className={button}>
              <Download className="size-4" />
              Add to Slack
            </a>
          )
        }
        empty="Not installed in a workspace yet. If a workspace admin must approve the app, choose Add to Slack again once they have."
        columns={["Workspace", "Team ID", "Granted scopes"]}
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
        description="In PagerDuty, under Integrations."
        urls={[
          {
            label: "Webhook URL",
            value: app.webhookUrl,
            where: "Generic Webhooks (v3): add a subscription delivering here.",
          },
        ]}
        settings={[
          ["App scopes", <Codes key="scopes" values={app.scopes} />],
          ["Subscription scope", "The account, or the services and teams factories watch"],
          ["Event subscription", <Codes key="types" values={app.eventTypes} />],
        ]}
      >
        {app.webhookSecretSet && isAdmin && <WebhookSecretForm replacing />}
      </ProviderSettings>
      <InstallationsCard
        title="Account"
        description="PagerDuty records every change, such as a note, as one of the account's users: the From user. The hub checks the account has a user with that email."
        columns={["Subdomain", "Region", "From"]}
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
  description: string;
  urls: { label: string; value: string; where: ReactNode }[];
  settings: [string, ReactNode][];
  children?: ReactNode;
}) {
  return (
    <Card title={`Set these on ${provider}`} description={description}>
      <div className="space-y-4">
        {urls.map(({ label, value, where }) => (
          <div key={label} className="grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
            <span className="pt-1.5 text-sm text-zinc-500">{label}</span>
            <div className="space-y-1">
              <div className="flex gap-2">
                <input
                  readOnly
                  value={value}
                  aria-label={label}
                  onFocus={(event) => event.target.select()}
                  className={`${input} min-w-0 grow font-mono`}
                />
                <CopyButton text={value} label={label} />
              </div>
              <p className="text-sm text-zinc-500">{where}</p>
            </div>
          </div>
        ))}
      </div>
      <dl className="divide-y divide-zinc-200 border-t border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {settings.map(([label, value]) => (
          <div key={label} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[16rem_1fr]">
            <dt className="font-medium">{label}</dt>
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
  description = "Factory code refers to an installation by its name.",
  action,
  empty,
  columns,
  rows,
  isAdmin,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  empty: string;
  columns: string[];
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
                <th>Installation name</th>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
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
