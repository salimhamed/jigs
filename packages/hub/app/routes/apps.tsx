import { Form, Link, redirect } from "react-router";
import { addGitHubApp } from "../../src/github.ts";
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
  const added = await addGitHubApp(context.db, context.config.encryptionKey, organizationId, {
    appId: field("appId"),
    slug: field("slug"),
    clientId: field("clientId"),
    clientSecret: field("clientSecret"),
    webhookSecret: field("webhookSecret"),
    privateKey: field("privateKey"),
  });
  if ("error" in added) return added;
  return redirect(`/apps/${added.app.id}`);
}

const fields = [
  { name: "appId", label: "App ID" },
  { name: "slug", label: "Slug, from the App's public page URL" },
  { name: "clientId", label: "Client ID" },
  { name: "clientSecret", label: "Client secret", secret: true },
  { name: "webhookSecret", label: "Webhook secret", secret: true },
];

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
          <h2 className="text-lg font-semibold">Add a GitHub App</h2>
          <p className="text-sm text-zinc-500">
            Create the App on GitHub first, under your organization's Developer settings, then copy
            its details here. Its page on the hub then shows what to set on GitHub.
          </p>
          {fields.map((field) => (
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
          ))}
          <label className="flex flex-col gap-1 text-sm">
            Private key (the .pem file's contents)
            <textarea name="privateKey" required rows={4} className={`${input} font-mono`} />
          </label>
          <button type="submit" className={button}>
            Add GitHub App
          </button>
        </Form>
      )}
    </div>
  );
}
