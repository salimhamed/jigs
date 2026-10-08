import { type Provider, pagerDutyScopes, providers } from "@jigs-ai/hub-protocol";
import type { ReactNode } from "react";
import { Form, Link, redirect } from "react-router";
import { addGitHubApp, githubWebhookPath } from "../../src/github.ts";
import { addLinearApp } from "../../src/linear.ts";
import { addPagerDutyApp } from "../../src/pagerduty.ts";
import { providerAppTitles } from "../../src/provider-names.ts";
import { addSlackApp } from "../../src/slack.ts";
import { requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { Codes } from "../components/codes.tsx";
import { PageHeader, UrlRow } from "../components/page.tsx";
import { Select } from "../components/select.tsx";
import { button, external, input, link, quietButton } from "../components/ui.ts";
import type { Route } from "./+types/new-app.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { role } = await requireMember(context, request);
  const chosen = new URL(request.url).searchParams.get("provider");
  return {
    isAdmin: role === "admin",
    provider: providers.find((provider) => provider === chosen) ?? null,
    urls: {
      hub: context.config.publicUrl.origin,
      githubWebhook: `${context.config.publicUrl.origin}${githubWebhookPath}`,
    },
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const admin = await requireAdmin(context, request);
  if ("error" in admin) return admin;
  const { organizationId } = admin;
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const { db, config } = context;
  const provider = field("provider") as Provider;
  const added = await (() => {
    switch (provider) {
      case "linear":
        return addLinearApp(db, config.encryptionKey, organizationId, {
          name: field("name"),
          clientId: field("clientId"),
          clientSecret: field("clientSecret"),
          webhookSecret: field("webhookSecret"),
        });
      case "slack":
        return addSlackApp(db, config.encryptionKey, organizationId, {
          name: field("name"),
          appId: field("appId"),
          clientId: field("clientId"),
          clientSecret: field("clientSecret"),
          signingSecret: field("signingSecret"),
        });
      case "pagerduty":
        return addPagerDutyApp(db, config.encryptionKey, organizationId, {
          name: field("name"),
          clientId: field("clientId"),
          clientSecret: field("clientSecret"),
          subdomain: field("subdomain"),
          region: field("region"),
          from: field("from"),
        });
      case "github":
        return addGitHubApp(db, config.encryptionKey, organizationId, {
          name: field("name"),
          appId: field("appId"),
          slug: field("slug"),
          clientId: field("clientId"),
          clientSecret: field("clientSecret"),
          webhookSecret: field("webhookSecret"),
          privateKey: field("privateKey"),
        });
      default:
        return { error: `There is no provider ${provider satisfies never}.` };
    }
  })();
  if ("error" in added) return added;
  return redirect(`/apps/${added.app.id}`);
}

type Field = {
  name: string;
  label: string;
  help?: ReactNode;
  secret?: boolean;
  multiline?: boolean;
  options?: { value: string; label: string }[];
};

type HubUrls = { hub: string; githubWebhook: string };

const generalAbout = (
  <>
    On the app's <strong>General</strong> page, under <strong>About</strong>.
  </>
);

const slackCredentials = (
  <>
    <strong>Basic Information</strong>, under <strong>App Credentials</strong>.
  </>
);

const forms: Record<
  Provider,
  {
    summary: string;
    primary: string;
    steps: (urls: HubUrls) => ReactNode[];
    note?: ReactNode;
    fields: Field[];
    submit: string;
  }
> = {
  github: {
    summary: "Repos, PRs, checks",
    primary: "Create a GitHub App for your organization first, then copy its details here.",
    steps: (urls) => [
      <>
        On GitHub, open your organization's <strong>Settings</strong> →{" "}
        <strong>Developer settings</strong> → <strong>GitHub Apps</strong> →{" "}
        <strong>New GitHub App</strong>.
      </>,
      <>
        Under <strong>Webhook</strong>, set the <strong>Webhook URL</strong> to:
        <UrlRow label="Webhook URL" value={urls.githubWebhook} />
      </>,
      <>
        Create the app, then copy the details below. The app's page lists the remaining settings
        once you add it here.
      </>,
    ],
    note: "This app is how factories work on GitHub, such as opening pull requests. It's separate from the GitHub login people use to sign in to this hub.",
    fields: [
      {
        name: "name",
        label: "Name",
        help: "What the hub calls this app. Only people see it, and you can change it later.",
      },
      {
        name: "slug",
        label: "Slug",
        help: (
          <>
            The end of the app's public page address: <code>github.com/apps/&lt;slug&gt;</code>.
          </>
        ),
      },
      { name: "appId", label: "App ID", help: generalAbout },
      { name: "clientId", label: "Client ID", help: generalAbout },
      {
        name: "clientSecret",
        label: "Client secret",
        secret: true,
        help: (
          <>
            On the <strong>General</strong> page, under <strong>Client secrets</strong>, click{" "}
            <strong>Generate a new client secret</strong>. GitHub shows it only once.
          </>
        ),
      },
      {
        name: "webhookSecret",
        label: "Webhook secret",
        secret: true,
        help: (
          <>
            The secret you entered under <strong>Webhook</strong> when creating the app. If you left
            it empty, set one on GitHub first.
          </>
        ),
      },
      {
        name: "privateKey",
        label: "Private key",
        multiline: true,
        help: (
          <>
            On the <strong>General</strong> page, under <strong>Private keys</strong>, click{" "}
            <strong>Generate a private key</strong>. Paste the whole contents of the downloaded{" "}
            <code>.pem</code> file.
          </>
        ),
      },
    ],
    submit: "Add GitHub App",
  },
  linear: {
    summary: "Issues, agent sessions",
    primary: "Create an OAuth application in Linear first, then copy its details here.",
    steps: (urls) => [
      <>
        In Linear, open <strong>Settings</strong> → <strong>API</strong> →{" "}
        <strong>OAuth applications</strong> → <strong>New</strong>.
      </>,
      <>
        Linear asks for a <strong>Redirect URI</strong> and a <strong>Webhook URL</strong> before
        the hub has made them. Enter the hub's address for both for now:
        <UrlRow label="Hub address" value={urls.hub} />
      </>,
      <>
        Create the application, then copy the details below. The app's page shows the real URLs once
        you add it here.
      </>,
    ],
    fields: [
      {
        name: "name",
        label: "Name",
        help: "Use the app's name in Linear. People @mention it by this name, and agents are told it's their own. You can rename it in Linear later; rename it here to match.",
      },
      { name: "clientId", label: "Client ID", help: "On the application's page in Linear." },
      {
        name: "clientSecret",
        label: "Client secret",
        secret: true,
        help: "On the application's page in Linear.",
      },
      {
        name: "webhookSecret",
        label: "Webhook signing secret",
        secret: true,
        help: (
          <>
            On the application's page, under <strong>Webhooks</strong>, once webhooks are turned on.
          </>
        ),
      },
    ],
    submit: "Add Linear app",
  },
  slack: {
    summary: "Mentions, messages",
    primary: "Create a Slack app first, then copy its details here.",
    steps: () => [
      <>
        At{" "}
        <a href="https://api.slack.com/apps" {...external} className={link}>
          api.slack.com/apps
        </a>
        , click <strong>Create New App</strong> → <strong>From scratch</strong>. Don't use a
        manifest.
      </>,
      <>
        Leave <strong>Socket Mode</strong> off.
      </>,
      <>
        Open <strong>Basic Information</strong>. The details below are under{" "}
        <strong>App Credentials</strong>.
      </>,
    ],
    fields: [
      {
        name: "name",
        label: "Name",
        help: "Usually the app's name in Slack. Factories see it as the bot's name.",
      },
      { name: "appId", label: "App ID", help: slackCredentials },
      { name: "clientId", label: "Client ID", help: slackCredentials },
      {
        name: "clientSecret",
        label: "Client secret",
        secret: true,
        help: (
          <>
            <strong>Basic Information</strong>, under <strong>App Credentials</strong>. Click{" "}
            <strong>Show</strong> to reveal it.
          </>
        ),
      },
      {
        name: "signingSecret",
        label: "Signing secret",
        secret: true,
        help: (
          <>
            <strong>Basic Information</strong>, under <strong>App Credentials</strong>. Slack uses
            it to sign the events it sends the hub.
          </>
        ),
      },
    ],
    submit: "Add Slack app",
  },
  pagerduty: {
    summary: "Incidents",
    primary: "Register an app in PagerDuty first, then copy its details here.",
    steps: (urls) => [
      <>
        In PagerDuty, open <strong>Integrations</strong> → <strong>App Registration</strong> →{" "}
        <strong>New App</strong>.
      </>,
      <>
        Choose <strong>Scoped OAuth</strong> and grant <Codes values={pagerDutyScopes} />.
      </>,
      <>
        PagerDuty asks for a <strong>Redirect URL</strong> the hub never uses. Enter the hub's
        address:
        <UrlRow label="Hub address" value={urls.hub} />
      </>,
      <>
        Register the app, then copy the details below. You'll add the webhook afterwards; the app's
        page shows its URL.
      </>,
    ],
    fields: [
      { name: "name", label: "Name", help: "What the hub calls this app. Only people see it." },
      {
        name: "clientId",
        label: "Client ID",
        help: (
          <>
            Shown when you register the app, under <strong>Scoped OAuth</strong>.
          </>
        ),
      },
      {
        name: "clientSecret",
        label: "Client secret",
        secret: true,
        help: (
          <>
            Shown when you register the app, under <strong>Scoped OAuth</strong>.
          </>
        ),
      },
      {
        name: "subdomain",
        label: "Account subdomain",
        help: (
          <>
            The first part of your PagerDuty address: <code>&lt;subdomain&gt;.pagerduty.com</code>.
          </>
        ),
      },
      {
        name: "region",
        label: "Region",
        help: (
          <>
            Where your account is hosted. Choose EU if you sign in at{" "}
            <code>app.eu.pagerduty.com</code>.
          </>
        ),
        options: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
      {
        name: "from",
        label: "From email",
        help: "The email of a user in this PagerDuty account, such as a shared on-call user. Notes and other changes factories make show up as this user. The hub checks that the user exists.",
      },
    ],
    submit: "Add PagerDuty app",
  },
};

export default function NewApp({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { isAdmin, provider, urls } = loaderData;
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Add an app" parent={{ to: "/apps", label: "Apps" }} />
      {!isAdmin ? (
        <p className="text-zinc-500">Only an admin can add an app.</p>
      ) : (
        <>
          <nav className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {providers.map((option) => (
              <Link
                key={option}
                to={`?provider=${option}`}
                aria-current={option === provider ? "page" : undefined}
                className={`space-y-0.5 rounded-lg border p-4 hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                  option === provider
                    ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                    : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                <div className="font-medium">{providerAppTitles[option]}</div>
                <div className="text-sm text-zinc-500">{forms[option].summary}</div>
              </Link>
            ))}
          </nav>
          {provider && <AppForm key={provider} provider={provider} urls={urls} />}
        </>
      )}
    </div>
  );
}

function AppForm({ provider, urls }: { provider: Provider; urls: HubUrls }) {
  const { primary, steps, note, fields, submit } = forms[provider];
  return (
    <Form method="post" className="max-w-2xl space-y-6">
      <input type="hidden" name="provider" value={provider} />
      <div className="space-y-3 text-sm">
        <p className="font-semibold">{primary}</p>
        <ol className="list-decimal space-y-3 pl-5 marker:text-zinc-500 [&_li>div]:mt-2">
          {steps(urls).map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a provider's steps never reorder.
            <li key={index}>{step}</li>
          ))}
        </ol>
        {note && <p className="text-zinc-500">{note}</p>}
      </div>
      <div className="space-y-5">
        {fields.map((field) => (
          <FieldInput key={field.name} field={field} />
        ))}
      </div>
      <div className="flex gap-2">
        <button type="submit" className={button}>
          {submit}
        </button>
        <Link to="/apps" className={quietButton}>
          Cancel
        </Link>
      </div>
    </Form>
  );
}

function FieldInput({ field }: { field: Field }) {
  const control = field.options ? (
    <Select id={field.name} name={field.name} defaultValue={field.options[0]?.value}>
      {field.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  ) : field.multiline ? (
    <textarea
      id={field.name}
      name={field.name}
      required
      rows={5}
      className={`${input} font-mono`}
    />
  ) : (
    <input
      id={field.name}
      name={field.name}
      type={field.secret ? "password" : "text"}
      required
      autoComplete="off"
      className={input}
    />
  );
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={field.name} className="font-medium">
        {field.label}
      </label>
      {field.help && <p className="text-zinc-500">{field.help}</p>}
      {control}
    </div>
  );
}
