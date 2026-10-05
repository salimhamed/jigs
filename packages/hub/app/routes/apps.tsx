import type { Provider } from "@jigs-ai/hub-protocol";
import { Form, Link, redirect } from "react-router";
import { addGitHubApp } from "../../src/github.ts";
import { addLinearApp } from "../../src/linear.ts";
import { addPagerDutyApp } from "../../src/pagerduty.ts";
import { addSlackApp } from "../../src/slack.ts";
import { listApps } from "../apps.server.ts";
import { requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { button, input, table } from "../components/ui.ts";
import type { Route } from "./+types/apps.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  return { isAdmin: role === "admin", apps: await listApps(context, organizationId) };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { organizationId, role } = await requireMember(context, request);
  if (role !== "admin") return { error: "Only an admin can add apps." };
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
        });
      case "github":
        return addGitHubApp(db, config.encryptionKey, organizationId, {
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

type Field = { name: string; label: string; secret?: boolean };

const githubFields: Field[] = [
  { name: "appId", label: "App ID" },
  { name: "slug", label: "Slug, from the App's public page URL" },
  { name: "clientId", label: "Client ID" },
  { name: "clientSecret", label: "Client secret", secret: true },
  { name: "webhookSecret", label: "Webhook secret", secret: true },
];

const linearFields: Field[] = [
  { name: "name", label: "Name, as the app is called in Linear" },
  { name: "clientId", label: "Client ID" },
  { name: "clientSecret", label: "Client secret", secret: true },
  { name: "webhookSecret", label: "Webhook signing secret", secret: true },
];

const slackFields: Field[] = [
  { name: "name", label: "Name, as the app is called in Slack" },
  { name: "appId", label: "App ID" },
  { name: "clientId", label: "Client ID" },
  { name: "clientSecret", label: "Client secret", secret: true },
  { name: "signingSecret", label: "Signing secret", secret: true },
];

const pagerDutyFields: Field[] = [
  { name: "name", label: "Name, as the app is called in PagerDuty" },
  { name: "clientId", label: "Client ID" },
  { name: "clientSecret", label: "Client secret", secret: true },
  { name: "subdomain", label: "Account subdomain, as in <subdomain>.pagerduty.com" },
];

function Fields({ fields }: { fields: Field[] }) {
  return fields.map((field) => (
    <label key={field.name} className="flex flex-col gap-1 text-sm">
      {field.label}
      <input
        name={field.name}
        type={field.secret ? "password" : "text"}
        required
        autoComplete="off"
        className={input}
      />
    </label>
  ));
}

export default function Apps({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Apps</h1>
      {loaderData.apps.length === 0 ? (
        <p className="text-zinc-500">No apps yet.</p>
      ) : (
        <table className={table}>
          <thead className="text-zinc-500">
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Installed on</th>
              <th>Factories</th>
            </tr>
          </thead>
          <tbody>
            {loaderData.apps.map((app) => (
              <tr key={app.id} className="border-t border-zinc-200 dark:border-zinc-800">
                <td>
                  <Link to={`/apps/${app.id}`} className="underline">
                    {app.name}
                  </Link>
                </td>
                <td>{app.provider}</td>
                <td>{app.installations.join(", ") || "—"}</td>
                <td>{app.factories.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {loaderData.isAdmin && (
        <Form method="post" className="max-w-xl space-y-3">
          <input type="hidden" name="provider" value="github" />
          <h2 className="text-lg font-semibold">Add a GitHub App</h2>
          <p className="text-sm text-zinc-500">
            Create the App on GitHub first, under your organization's Developer settings, then copy
            its details here. Its page on the hub then shows what to set on GitHub.
          </p>
          <Fields fields={githubFields} />
          <label className="flex flex-col gap-1 text-sm">
            Private key (the .pem file's contents)
            <textarea name="privateKey" required rows={4} className={`${input} font-mono`} />
          </label>
          <button type="submit" className={button}>
            Add GitHub App
          </button>
        </Form>
      )}
      {loaderData.isAdmin && (
        <Form method="post" className="max-w-xl space-y-3">
          <input type="hidden" name="provider" value="linear" />
          <h2 className="text-lg font-semibold">Add a Linear app</h2>
          <p className="text-sm text-zinc-500">
            Create an OAuth application in Linear first, under Settings, API, then copy its details
            here. Its page on the hub then shows what to set in Linear and connects workspaces.
          </p>
          <Fields fields={linearFields} />
          <button type="submit" className={button}>
            Add Linear app
          </button>
        </Form>
      )}
      {loaderData.isAdmin && (
        <Form method="post" className="max-w-xl space-y-3">
          <input type="hidden" name="provider" value="slack" />
          <h2 className="text-lg font-semibold">Add a Slack app</h2>
          <p className="text-sm text-zinc-500">
            Create an app at api.slack.com/apps first, from scratch, then copy its details from
            Basic Information here. Its page on the hub then shows what to set in Slack and installs
            it in workspaces.
          </p>
          <Fields fields={slackFields} />
          <button type="submit" className={button}>
            Add Slack app
          </button>
        </Form>
      )}
      {loaderData.isAdmin && (
        <Form method="post" className="max-w-xl space-y-3">
          <input type="hidden" name="provider" value="pagerduty" />
          <h2 className="text-lg font-semibold">Add a PagerDuty connection</h2>
          <p className="text-sm text-zinc-500">
            Create an app in PagerDuty first, under Integrations, App Registration, with Scoped
            OAuth and the scopes its page on the hub lists, then copy its details here. The hub
            checks them by getting a token. The connection's page then shows the webhook to add in
            PagerDuty and takes its signing secret.
          </p>
          <Fields fields={pagerDutyFields} />
          <label className="flex flex-col gap-1 text-sm">
            Region
            <select name="region" defaultValue="us" className={input}>
              <option value="us">US</option>
              <option value="eu">EU</option>
            </select>
          </label>
          <button type="submit" className={button}>
            Add PagerDuty connection
          </button>
        </Form>
      )}
    </div>
  );
}
