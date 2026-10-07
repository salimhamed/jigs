import { type Provider, providers } from "@jigs-ai/hub-protocol";
import type { ReactNode } from "react";
import { Form, Link, redirect } from "react-router";
import { addGitHubApp } from "../../src/github.ts";
import { addLinearApp } from "../../src/linear.ts";
import { addPagerDutyApp } from "../../src/pagerduty.ts";
import { addSlackApp } from "../../src/slack.ts";
import { requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { PageHeader } from "../components/page.tsx";
import { linearNameHint } from "../components/provider.tsx";
import { button, input, quietButton } from "../components/ui.ts";
import type { Route } from "./+types/new-app.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { role } = await requireMember(context, request);
  const chosen = new URL(request.url).searchParams.get("provider");
  return {
    isAdmin: role === "admin",
    provider: providers.find((provider) => provider === chosen) ?? null,
    hubUrl: context.config.publicUrl.origin,
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
  hint?: string;
  secret?: boolean;
  multiline?: boolean;
  options?: { value: string; label: string }[];
  wide?: boolean;
};

const forms: Record<
  Provider,
  {
    card: { title: string; summary: string };
    intro: (hubUrl: string) => ReactNode;
    fields: Field[];
    submit: string;
  }
> = {
  github: {
    card: { title: "GitHub App", summary: "Repos, PRs, checks" },
    intro: () => (
      <>
        <p>
          Create the App on GitHub first, under your organization's Developer settings, then copy
          its details here.
        </p>
        <p className="text-zinc-500">
          This is not the hub's sign-in app: that one is an OAuth App set in the hub's environment.
        </p>
      </>
    ),
    fields: [
      { name: "name", label: "Name", hint: "Shown on the hub; you can change it later" },
      { name: "slug", label: "Slug", hint: "From the public page URL, github.com/apps/<slug>" },
      { name: "appId", label: "App ID", hint: "About section" },
      { name: "clientId", label: "Client ID", hint: "About section" },
      {
        name: "clientSecret",
        label: "Client secret",
        hint: "Generate a new client secret",
        secret: true,
      },
      {
        name: "webhookSecret",
        label: "Webhook secret",
        hint: "The Secret you set under Webhook",
        secret: true,
      },
      {
        name: "privateKey",
        label: "Private key",
        hint: "Paste the .pem file's contents",
        multiline: true,
        wide: true,
      },
    ],
    submit: "Add GitHub App",
  },
  linear: {
    card: { title: "Linear app", summary: "Issues, agent sessions" },
    intro: (hubUrl) => (
      <>
        <p>
          Create an OAuth application in Linear first, under Settings, API, then copy its details
          here.
        </p>
        <p className="text-zinc-500">
          Linear asks for a Redirect URI and a Webhook URL before the hub has made them. Enter the
          hub's address, <code>{hubUrl}</code>, for both, then replace them with the URLs the app's
          page shows once you add it.
        </p>
      </>
    ),
    fields: [
      { name: "name", label: "Name", hint: linearNameHint, wide: true },
      { name: "clientId", label: "Client ID" },
      { name: "clientSecret", label: "Client secret", secret: true },
      { name: "webhookSecret", label: "Webhook signing secret", secret: true },
    ],
    submit: "Add Linear app",
  },
  slack: {
    card: { title: "Slack app", summary: "Mentions, messages" },
    intro: () => (
      <p>
        Create an app at api.slack.com/apps first as a blank app, not from a template, with Socket
        Mode off. Then copy its details from Basic Information here.
      </p>
    ),
    fields: [
      { name: "name", label: "Name", hint: "As the app is called in Slack" },
      { name: "appId", label: "App ID" },
      { name: "clientId", label: "Client ID" },
      { name: "clientSecret", label: "Client secret", secret: true },
      { name: "signingSecret", label: "Signing secret", secret: true },
    ],
    submit: "Add Slack app",
  },
  pagerduty: {
    card: { title: "PagerDuty", summary: "Incidents" },
    intro: (hubUrl) => (
      <>
        <p>
          Register an app in PagerDuty first, under Integrations, App Registration, with Scoped
          OAuth and the scopes its page on the hub lists, then copy its details here. The hub checks
          them by getting a token and finding the from user.
        </p>
        <p className="text-zinc-500">
          PagerDuty asks for a redirect URL the hub never uses: enter the hub's address,{" "}
          <code>{hubUrl}</code>. The webhook comes after: the app's page shows its URL.
        </p>
      </>
    ),
    fields: [
      { name: "name", label: "Name", hint: "As the app is called in PagerDuty" },
      { name: "clientId", label: "Client ID" },
      { name: "clientSecret", label: "Client secret", secret: true },
      { name: "subdomain", label: "Account subdomain", hint: "As in <subdomain>.pagerduty.com" },
      {
        name: "region",
        label: "Region",
        options: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
      {
        name: "from",
        label: "From email",
        hint: "The account's user that factories make changes as, such as an on-call account",
      },
    ],
    submit: "Add PagerDuty app",
  },
};

export default function NewApp({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { isAdmin, provider, hubUrl } = loaderData;
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
                <div className="font-medium">{forms[option].card.title}</div>
                <div className="text-sm text-zinc-500">{forms[option].card.summary}</div>
              </Link>
            ))}
          </nav>
          {provider ? (
            <AppForm key={provider} provider={provider} hubUrl={hubUrl} />
          ) : (
            <p className="text-zinc-500">Choose the provider of the app you made.</p>
          )}
        </>
      )}
    </div>
  );
}

function AppForm({ provider, hubUrl }: { provider: Provider; hubUrl: string }) {
  const { intro, fields, submit } = forms[provider];
  return (
    <Form method="post" className="space-y-5">
      <input type="hidden" name="provider" value={provider} />
      <div className="space-y-2 text-sm">{intro(hubUrl)}</div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
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
    <select
      id={field.name}
      name={field.name}
      defaultValue={field.options[0]?.value}
      className={input}
    >
      {field.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
    <div className={`flex flex-col gap-1 text-sm ${field.wide ? "sm:col-span-2" : ""}`}>
      <div className="flex flex-wrap justify-between gap-x-4">
        <label htmlFor={field.name} className="font-medium">
          {field.label}
        </label>
        {field.hint && <span className="text-zinc-500">{field.hint}</span>}
      </div>
      {control}
    </div>
  );
}
