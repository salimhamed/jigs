import { Download, Link2, Trash2 } from "lucide-react";
import { data, Form, redirect } from "react-router";
import { removeApp, setAssignments } from "../../src/apps.ts";
import { readApp } from "../apps.server.ts";
import { requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { button, quietButton, table } from "../components/ui.ts";
import type { Route } from "./+types/app.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => data(null, { status: 404, statusText: "Not Found" });

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  const app = UUID.test(params.id) ? await readApp(context, organizationId, params.id) : null;
  if (!app) throw notFound();
  return { isAdmin: role === "admin", app };
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const { organizationId, role } = await requireMember(context, request);
  if (role !== "admin") return { error: "Only an admin can change apps." };
  if (!UUID.test(params.id)) throw notFound();
  const form = await request.formData();
  switch (form.get("intent")) {
    case "remove":
      await removeApp(context.db, organizationId, params.id);
      return redirect("/apps");
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
      {app.provider === "github" ? (
        <GitHubApp app={app} isAdmin={isAdmin} />
      ) : (
        <LinearApp app={app} isAdmin={isAdmin} />
      )}

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

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="w-28 text-zinc-500">{label}</span>
      <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-900">{value}</code>
      <CopyButton text={value} label={label} />
    </li>
  );
}
