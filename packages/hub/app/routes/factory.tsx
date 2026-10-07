import type { Provider } from "@jigs-ai/hub-protocol";
import { ChevronRight, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { data, Form, Link, redirect, useFetcher } from "react-router";
import { assignApp, assignedApps, isUuid, unassignApp } from "../../src/apps.ts";
import { manages, removeFactory, renameFactory } from "../../src/factories.ts";
import { providerNames } from "../../src/provider-names.ts";
import { listInstalledApps } from "../apps.server.ts";
import { asManager, requireFactoryManager, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { ConfirmForm } from "../components/confirm-form.tsx";
import { ReissueTokenButton, RemoveFactoryButton } from "../components/factory-confirms.tsx";
import { factoryHints } from "../components/factory-hints.ts";
import { Hint } from "../components/hint.tsx";
import { DangerRow, Details, PageHeader, SettingRow, StatusDot } from "../components/page.tsx";
import { TimeAgo } from "../components/time.tsx";
import {
  card,
  dangerOutlineButton,
  input,
  link,
  quietButton,
  secondaryButton,
  table,
  warningText,
} from "../components/ui.ts";
import { countEvents, readEventLog, readFactory, readLastEvents } from "../factories.server.ts";
import type { Route } from "./+types/factory.ts";
import type { loader as eventLoader } from "./factory-event.ts";
import type { loader as eventsLoader } from "./factory-events.ts";

const notFound = () => data(null, { status: 404, statusText: "Not Found" });

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const member = await requireMember(context, request);
  const { organizationId } = member;
  const found = isUuid(params.id) ? await readFactory(context, organizationId, params.id) : null;
  if (!found) throw notFound();
  const { cursor, createdBy, ...factory } = found;
  const isAdmin = member.role === "admin";
  const canManage = manages(asManager(member), { createdBy });
  if (new URL(request.url).searchParams.get("tab") === "activity") {
    const [log, total] = await Promise.all([
      readEventLog(context, { id: factory.id, cursor }, null),
      countEvents(context, factory.id),
    ]);
    return { tab: "activity" as const, factory, ...log, total };
  }
  const [connected, lastEvents, organizationApps] = await Promise.all([
    assignedApps(context.db, factory.id),
    readLastEvents(context, factory.id),
    listInstalledApps(context, organizationId),
  ]);
  return {
    tab: "settings" as const,
    isAdmin,
    canManage,
    factory,
    connected: connected.map((app) => ({ ...app, lastEventAt: lastEvents[app.id] ?? null })),
    hasApps: organizationApps.length > 0,
    available: organizationApps.filter((app) => !connected.some(({ id }) => id === app.id)),
  };
}

export async function action({ context, request, params }: Route.ActionArgs) {
  if (!isUuid(params.id)) throw notFound();
  const form = await request.formData();
  const intent = form.get("intent");
  const caller = await requireFactoryManager(context, request, params.id);
  if ("error" in caller) return caller;
  const { organizationId } = caller;
  const appId = String(form.get("appId") ?? "");
  switch (intent) {
    case "connect":
      if (!isUuid(appId)) return { error: "Choose an app to connect." };
      await assignApp(context.db, organizationId, params.id, appId);
      return { connected: appId };
    case "disconnect":
      if (isUuid(appId)) await unassignApp(context.db, organizationId, params.id, appId);
      return { message: "Disconnected the app." };
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

const installationsHint = "The names your factory code uses to choose where to work.";

type Loaded = Route.ComponentProps["loaderData"];

export default function Factory({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { factory } = loaderData;
  return (
    <div className="space-y-6">
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
        <Details
          items={[
            {
              label: "Last seen",
              hint: factoryHints.lastSeen,
              value: factory.lastSeenAt ? <TimeAgo iso={factory.lastSeenAt} /> : "never",
            },
            {
              label: "Factory version",
              hint: factoryHints.version,
              value: factory.lastSeenVersion ?? "—",
              className: "font-mono",
            },
            {
              label: "Unconfirmed events",
              hint: factoryHints.unconfirmed,
              value: factory.unconfirmed,
              className: factory.unconfirmed > 0 ? warningText : undefined,
            },
          ]}
        />
      </div>
      <nav className="flex gap-6 border-b border-zinc-200 text-sm dark:border-zinc-800">
        <Tab to="?" current={loaderData.tab === "settings"}>
          Settings
        </Tab>
        <Tab to="?tab=activity" current={loaderData.tab === "activity"}>
          Activity
        </Tab>
      </nav>
      {loaderData.tab === "settings" ? (
        <SettingsTab
          loaded={loaderData}
          justConnected={(actionData && "connected" in actionData && actionData.connected) || null}
        />
      ) : (
        // A new first page means new events arrived; the older pages shown are then stale.
        <ActivityTab key={loaderData.messages[0]?.position ?? "none"} loaded={loaderData} />
      )}
    </div>
  );
}

function Tab({ to, current, children }: { to: string; current: boolean; children: string }) {
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className={`-mb-px border-b-2 pb-2 ${
        current
          ? "border-zinc-900 font-medium dark:border-zinc-100"
          : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
      }`}
    >
      {children}
    </Link>
  );
}

function SettingsTab({
  loaded,
  justConnected,
}: {
  loaded: Extract<Loaded, { tab: "settings" }>;
  justConnected: string | null;
}) {
  const { isAdmin, canManage, factory, connected, available, hasApps } = loaded;
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-1">
            <h2 className="font-semibold">
              Connected apps <span className="font-normal text-zinc-500">· {connected.length}</span>
            </h2>
            <p className="text-sm text-zinc-500">
              Connecting an app sends its events to this factory and lets the factory act through
              it, for example opening pull requests through a GitHub App or replying in Slack.
            </p>
          </div>
          {canManage && (
            <ConnectApp
              factoryName={factory.name}
              apps={available}
              hasApps={hasApps}
              isAdmin={isAdmin}
            />
          )}
        </div>
        {connected.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No apps connected, so it receives no provider events.
          </p>
        ) : (
          <div className={`${card} overflow-x-auto`}>
            <table className={table}>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Provider</th>
                  <th>
                    <Hint label="Installations" tip={installationsHint} />
                  </th>
                  <th>
                    <Hint
                      label="Last event"
                      tip="When this factory last received an event from this app."
                    />
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {connected.map((app) => (
                  <tr
                    key={app.id}
                    className={
                      app.id === justConnected ? "bg-emerald-50 dark:bg-emerald-950/40" : undefined
                    }
                  >
                    <td>
                      <span className="flex items-center gap-2.5">
                        <Link to={`/apps/${app.id}`} className={link}>
                          {app.name}
                        </Link>
                        {app.id === justConnected && (
                          <span className="text-emerald-600 dark:text-emerald-400">Connected</span>
                        )}
                      </span>
                    </td>
                    <td className="text-zinc-500">{providerNames[app.provider]}</td>
                    <td>
                      <InstallationNames installations={app.installations} />
                    </td>
                    <td className="whitespace-nowrap">
                      {app.lastEventAt ? (
                        <TimeAgo iso={app.lastEventAt} />
                      ) : (
                        <span className="text-zinc-500">No events yet</span>
                      )}
                    </td>
                    <td className="text-right">
                      {canManage && (
                        <ConfirmForm
                          fields={{ intent: "disconnect", appId: app.id }}
                          title={`Disconnect ${app.name} from ${factory.name}?`}
                          body={`${factory.name} stops receiving ${app.name} events and can no longer ask for its tokens. Events already received stay in the log.`}
                          confirmLabel="Disconnect"
                          destructive
                          className={quietButton}
                        >
                          Disconnect
                        </ConfirmForm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage && (
        <section className="space-y-3">
          <h2 className="font-semibold">General</h2>
          <div className={`${card} divide-y divide-zinc-200 dark:divide-zinc-800`}>
            <SettingRow label="Name" hint="Shown in the factory list.">
              <Form method="post" className="flex flex-wrap gap-2">
                <input
                  name="name"
                  required
                  defaultValue={factory.name}
                  aria-label="Name"
                  className={`${input} min-w-0 grow`}
                />
                <button type="submit" name="intent" value="rename" className={secondaryButton}>
                  Save
                </button>
              </Form>
            </SettingRow>
            <SettingRow
              label="Connection token"
              hint="Issuing a new one stops the old token. Run the new connect command on the factory."
            >
              <ReissueTokenButton factory={factory} className={secondaryButton}>
                <KeyRound className="size-4" />
                Re-issue token
              </ReissueTokenButton>
            </SettingRow>
          </div>
        </section>
      )}

      {canManage && (
        <DangerRow
          label="Remove factory"
          hint="Disconnects it from all apps and drops its unconfirmed events."
        >
          <RemoveFactoryButton factory={factory} className={dangerOutlineButton}>
            <Trash2 className="size-4" />
            Remove factory
          </RemoveFactoryButton>
        </DangerRow>
      )}
    </div>
  );
}

type Installations = { account: string; installationName: string | null }[];

/** The apps not yet connected, in a panel that filters them by name. */
function ConnectApp({
  factoryName,
  apps,
  hasApps,
  isAdmin,
}: {
  factoryName: string;
  apps: { id: string; provider: Provider; name: string; installations: Installations }[];
  hasApps: boolean;
  isAdmin: boolean;
}) {
  const [search, setSearch] = useState("");
  const shown = apps.filter((app) => app.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <button type="button" popoverTarget="connect-app" className={secondaryButton}>
        <Plus className="size-4" />
        Connect app
      </button>
      <div
        id="connect-app"
        popover="auto"
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/30 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <div className="p-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className={`${input} w-full`}
          />
        </div>
        <p className="px-4 pb-2 text-sm text-zinc-500">Not connected to {factoryName}</p>
        <ul className="max-h-80 divide-y divide-zinc-200 overflow-y-auto border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {shown.length === 0 && (
            <li className="px-4 py-3 text-sm text-zinc-500">
              {!hasApps
                ? "No apps yet."
                : apps.length === 0
                  ? "Every app is connected."
                  : "No app matches."}
            </li>
          )}
          {shown.map((app) => (
            <li key={app.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 grow">
                <div className="text-sm">
                  {app.name} <span className="text-zinc-500">{providerNames[app.provider]}</span>
                </div>
                <InstallationNames installations={app.installations} />
              </div>
              <Form
                method="post"
                onSubmit={(event) =>
                  (event.currentTarget.closest("[popover]") as HTMLElement | null)?.hidePopover()
                }
              >
                <input type="hidden" name="appId" value={app.id} />
                <button type="submit" name="intent" value="connect" className={secondaryButton}>
                  Connect
                </button>
              </Form>
            </li>
          ))}
        </ul>
        {isAdmin && (
          <p className="px-4 py-3 text-sm text-zinc-500">
            Not listed?{" "}
            <Link to="/apps/new" className={link}>
              Add an app
            </Link>
          </p>
        )}
      </div>
    </>
  );
}

type Message = Extract<Loaded, { tab: "activity" }>["messages"][number];

function ActivityTab({ loaded }: { loaded: Extract<Loaded, { tab: "activity" }> }) {
  const { factory, total } = loaded;
  // Each older page continues from the last position shown, so events arriving meanwhile
  // never shift or repeat a row; a reload shows the newest again.
  const [olderPages, setOlderPages] = useState<Message[][]>([]);
  const more = useFetcher<typeof eventsLoader>();
  useEffect(() => {
    const page = more.data?.messages;
    if (page) setOlderPages((pages) => [...pages, page]);
  }, [more.data]);
  const messages = [loaded.messages, ...olderPages].flat();
  const older = more.data ? more.data.older : loaded.older;
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">
        Event log{" "}
        <span className="font-normal text-zinc-500">
          · {total.toLocaleString("en-US")} events · showing{" "}
          {messages.length.toLocaleString("en-US")}
        </span>
      </h2>
      {messages.length === 0 ? (
        <p className="text-sm text-zinc-500">No events.</p>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className={table}>
            <thead>
              <tr>
                <th>#</th>
                <th>Provider</th>
                <th>Event</th>
                <th>Received</th>
                <th>
                  <Hint
                    label="Confirmed"
                    tip="Yes once the factory confirms it received the event. Pending until then."
                  />
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => (
                <EventRow key={message.position} factoryId={factory.id} message={message} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {older && (
        <button
          type="button"
          disabled={more.state === "loading"}
          onClick={() => more.load(`/factories/${factory.id}/events?before=${older}`)}
          className={secondaryButton}
        >
          {more.state === "loading" ? "Loading…" : "Load older events"}
        </button>
      )}
    </section>
  );
}

function EventRow({ factoryId, message }: { factoryId: string; message: Message }) {
  const [open, setOpen] = useState(false);
  const payload = useFetcher<typeof eventLoader>();
  const expandable = message.kind !== "fellBehind";
  const toggle = () => {
    if (!open && !payload.data) payload.load(`/factories/${factoryId}/events/${message.position}`);
    setOpen(!open);
  };
  return (
    <>
      <tr
        onClick={expandable ? toggle : undefined}
        className={
          expandable ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900" : undefined
        }
      >
        <td className="font-mono text-zinc-500 tabular-nums">{message.position}</td>
        <td>{message.provider ? providerNames[message.provider] : "—"}</td>
        <td className={expandable ? "font-mono" : "text-zinc-500"}>
          {expandable ? message.name : "fell behind"}
        </td>
        <td className="whitespace-nowrap">
          <TimeAgo iso={message.receivedAt} />
        </td>
        <td>{message.confirmed ? "Yes" : <span className={warningText}>Pending</span>}</td>
        <td className="w-10 text-right">
          {expandable && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide payload" : "Show payload"}
              className={quietButton}
            >
              <ChevronRight className={`size-4 ${open ? "rotate-90" : ""}`} />
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-zinc-50 dark:bg-zinc-900/50">
            <pre className="max-h-96 overflow-auto text-xs">
              {payload.data ? (payload.data.payload ?? "No longer kept.") : "Loading…"}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function InstallationNames({ installations }: { installations: Installations }) {
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
            <span title={installation.account}>{installation.installationName}</span>
          )}
        </span>
      ))}
    </span>
  );
}
