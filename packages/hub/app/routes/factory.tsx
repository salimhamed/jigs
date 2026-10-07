import { ChevronRight, KeyRound, Plus, Save, Trash2, X } from "lucide-react";
import { data, Form, Link, redirect } from "react-router";
import { assignApp, assignedApps, isUuid, unassignApp } from "../../src/apps.ts";
import { removeFactory, renameFactory } from "../../src/factories.ts";
import { providerNames } from "../../src/provider-names.ts";
import { listApps } from "../apps.server.ts";
import { requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { ConfirmForm } from "../components/confirm-form.tsx";
import { Card, PageHeader, StatusDot } from "../components/page.tsx";
import { ProviderInitials } from "../components/provider.tsx";
import { Time, TimeAgo } from "../components/time.tsx";
import {
  button,
  card,
  dangerButton,
  input,
  quietButton,
  secondaryButton,
  table,
  warningText,
} from "../components/ui.ts";
import { readEventLog, readFactory } from "../factories.server.ts";
import type { Route } from "./+types/factory.ts";

const notFound = () => data(null, { status: 404, statusText: "Not Found" });

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  const factory = isUuid(params.id) ? await readFactory(context, organizationId, params.id) : null;
  if (!factory) throw notFound();
  const before = new URL(request.url).searchParams.get("before");
  const [log, apps, organizationApps] = await Promise.all([
    readEventLog(context, factory.id, before && /^\d{1,19}$/.test(before) ? BigInt(before) : null),
    assignedApps(context.db, factory.id),
    listApps(context, organizationId),
  ]);
  return {
    isAdmin: role === "admin",
    factory,
    apps,
    unassignedApps: organizationApps
      .filter((app) => !apps.some(({ id }) => id === app.id))
      .map(({ id, provider, name }) => ({ id, provider, name })),
    ...log,
    paged: before !== null,
  };
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const admin = await requireAdmin(context, request);
  if ("error" in admin) return admin;
  const { organizationId } = admin;
  if (!isUuid(params.id)) throw notFound();
  const form = await request.formData();
  const appId = String(form.get("appId") ?? "");
  switch (form.get("intent")) {
    case "assign":
      if (!isUuid(appId)) return { error: "Choose an app to assign." };
      await assignApp(context.db, organizationId, params.id, appId);
      return { message: "Assigned the app." };
    case "unassign":
      if (isUuid(appId)) await unassignApp(context.db, organizationId, params.id, appId);
      return { message: "Unassigned the app." };
    case "rename": {
      const name = String(form.get("name") ?? "").trim();
      const renamed = await renameFactory(context.db, organizationId, params.id, name);
      if ("error" in renamed) return renamed;
      return { message: `Renamed the factory ${renamed.name}.` };
    }
    case "remove":
      await removeFactory(context.db, context.waiters, organizationId, params.id);
      return redirect("/factories");
    default:
      throw notFound();
  }
}

export default function Factory({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { isAdmin, factory, apps, unassignedApps, messages, older, paged } = loaderData;
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <PageHeader
          title={
            <>
              <StatusDot online={factory.online} />
              {factory.name}
            </>
          }
          parent={{ to: "/factories", label: "Factories" }}
        />
        <dl className="flex flex-wrap gap-x-8 gap-y-1 text-sm [&_dt]:text-zinc-500 [&>div]:flex [&>div]:gap-1.5">
          <div>
            <dt>Last seen</dt>
            <dd>{factory.lastSeenAt ? <TimeAgo iso={factory.lastSeenAt} /> : "never"}</dd>
          </div>
          <div>
            <dt>jigs</dt>
            <dd className="font-mono">{factory.lastSeenVersion ?? "—"}</dd>
          </div>
          <div>
            <dt>Unconfirmed</dt>
            <dd className={factory.unconfirmed > 0 ? warningText : undefined}>
              {factory.unconfirmed}
            </dd>
          </div>
        </dl>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold">Assigned apps</h2>
          <p className="text-sm text-zinc-500">
            The factory receives these apps' events and can ask for their tokens.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {apps.length === 0 && (
            <p className="text-sm text-zinc-500">
              No apps assigned, so it receives no provider events.
            </p>
          )}
          {apps.map((app) => (
            <div
              key={app.id}
              className={`${card} flex items-center gap-2 py-1.5 pr-1.5 pl-3 text-sm`}
            >
              <ProviderInitials provider={app.provider} />
              <Link to={`/apps/${app.id}`} className="font-medium hover:underline">
                {app.name}
              </Link>
              <InstallationNames installations={app.installations} />
              {isAdmin && (
                <Form method="post">
                  <input type="hidden" name="appId" value={app.id} />
                  <button
                    type="submit"
                    name="intent"
                    value="unassign"
                    aria-label={`Unassign ${app.name}`}
                    title="Unassign"
                    className={quietButton}
                  >
                    <X className="size-3.5" />
                  </button>
                </Form>
              )}
            </div>
          ))}
        </div>
        {isAdmin && unassignedApps.length > 0 && (
          <Form method="post" className="flex flex-wrap items-center gap-2">
            <select
              name="appId"
              required
              aria-label="App to assign"
              className={input}
              defaultValue=""
            >
              <option value="" disabled>
                Choose an app…
              </option>
              {unassignedApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name} ({providerNames[app.provider]})
                </option>
              ))}
            </select>
            <button type="submit" name="intent" value="assign" className={secondaryButton}>
              <Plus className="size-4" />
              Assign app
            </button>
          </Form>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-semibold">
            Event log <span className="font-normal text-zinc-500">· newest first</span>
          </h2>
          <div className="flex gap-2">
            {paged && (
              <Link to="?" className={secondaryButton}>
                Newest
              </Link>
            )}
            {older && (
              <Link to={`?before=${older}`} className={secondaryButton}>
                Older
              </Link>
            )}
          </div>
        </div>
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-500">No events.</p>
        ) : (
          <div className={`${card} overflow-x-auto`}>
            <table className={`${table} [&_td]:align-top`}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Provider</th>
                  <th>Event</th>
                  <th>Received</th>
                  <th>Confirmed</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((message) => (
                  <tr key={message.position}>
                    <td className="font-mono text-zinc-500 tabular-nums">{message.position}</td>
                    <td>{message.provider ? providerNames[message.provider] : "—"}</td>
                    <td>
                      {message.kind === "fellBehind" ? (
                        <span className="text-zinc-500">fell behind</span>
                      ) : (
                        <details className="group">
                          <summary className="flex cursor-pointer list-none items-center gap-1 font-mono">
                            <ChevronRight className="size-3.5 text-zinc-500 group-open:rotate-90" />
                            {message.name}
                          </summary>
                          <pre className="mt-2 max-h-96 max-w-2xl overflow-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
                            {message.payload}
                          </pre>
                        </details>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <Time iso={message.receivedAt} />
                    </td>
                    <td>
                      {message.confirmed ? "Yes" : <span className={warningText}>Pending</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin && (
        <Card title="Manage" danger>
          <Form method="post" className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              Name
              <input
                name="name"
                required
                defaultValue={factory.name}
                className={`${input} min-w-64`}
              />
            </label>
            <button type="submit" name="intent" value="rename" className={button}>
              <Save className="size-4" />
              Rename
            </button>
          </Form>
          <div className="flex flex-wrap gap-2">
            <ConfirmForm
              action="/factories/new"
              fields={{ intent: "reissue", factoryId: factory.id }}
              question={`Re-issue the token of ${factory.name}? Its current token stops working.`}
              className={secondaryButton}
            >
              <KeyRound className="size-4" />
              Re-issue token
            </ConfirmForm>
            <ConfirmForm
              fields={{ intent: "remove" }}
              question={`Remove ${factory.name} and every message waiting for it?`}
              className={dangerButton}
            >
              <Trash2 className="size-4" />
              Remove factory
            </ConfirmForm>
          </div>
        </Card>
      )}
    </div>
  );
}

function InstallationNames({
  installations,
}: {
  installations: { account: string; installationName: string | null }[];
}) {
  if (installations.length === 0) return <span className="text-zinc-500">not installed</span>;
  return (
    <span className="font-mono text-xs">
      {installations.map((installation, index) => (
        <span key={installation.account}>
          {index > 0 && ", "}
          {installation.installationName === null ? (
            <span className={warningText} title={installation.account}>
              needs a name
            </span>
          ) : (
            <span title={installation.account} className="text-zinc-500">
              {installation.installationName}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
