import { ChevronRight, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { data, Form, Link, redirect, useFetcher } from "react-router";
import { assignApp, isUuid, unassignApp } from "../../src/apps.ts";
import { manages, removeFactory, renameFactory } from "../../src/factories.ts";
import { providerNames } from "../../src/provider-names.ts";
import { requireFactoryManager, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { ConfirmForm } from "../components/confirm-form.tsx";
import {
  ConnectApp,
  JustConnected,
  justConnectedRow,
  useJustConnected,
} from "../components/connect-app.tsx";
import { ReissueTokenButton, RemoveFactoryButton } from "../components/factory-confirms.tsx";
import { factoryHints } from "../components/factory-hints.ts";
import { Hint } from "../components/hint.tsx";
import { InstallationNames } from "../components/installation-names.tsx";
import {
  DangerRow,
  Details,
  PageHeader,
  SettingRow,
  StatusDot,
  Tabs,
} from "../components/page.tsx";
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
import { countEvents, readEventLog, readFactory, readFactoryApps } from "../factories.server.ts";
import type { Route } from "./+types/factory.ts";
import type { loader as eventLoader } from "./factory-event.ts";
import type { loader as eventsLoader } from "./factory-events.ts";

const allFactories = "/factories?tab=all";

const notFound = () => data(null, { status: 404, statusText: "Not Found" });

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const member = await requireMember(context, request);
  const { organizationId } = member;
  const found = isUuid(params.id) ? await readFactory(context, organizationId, params.id) : null;
  if (!found) throw notFound();
  const { cursor, createdBy, ...factory } = found;
  const isAdmin = member.role === "admin";
  const canManage = manages(member, { createdBy });
  if (new URL(request.url).searchParams.get("tab") === "activity") {
    const [log, total] = await Promise.all([
      readEventLog(context, { id: factory.id, cursor }, null),
      countEvents(context, factory.id),
    ]);
    return { tab: "activity" as const, factory, ...log, total };
  }
  return {
    tab: "settings" as const,
    isAdmin,
    canManage,
    factory,
    ...(await readFactoryApps(context, organizationId, factory.id)),
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
      // Back to the list tab it was removed from; any other place could lead off the hub.
      return redirect(form.get("returnTo") === allFactories ? allFactories : "/factories");
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
      <Tabs
        tabs={[
          { to: "?", label: "Settings", current: loaderData.tab === "settings" },
          { to: "?tab=activity", label: "Activity", current: loaderData.tab === "activity" },
        ]}
      />
      {loaderData.tab === "settings" ? (
        <SettingsTab key={factory.id} loaded={loaderData} />
      ) : (
        // A new first page means new events arrived; the older pages shown are then stale.
        <ActivityTab key={loaderData.messages[0]?.position ?? "none"} loaded={loaderData} />
      )}
    </div>
  );
}

function SettingsTab({ loaded }: { loaded: Extract<Loaded, { tab: "settings" }> }) {
  const { isAdmin, canManage, factory, connected, available, hasApps } = loaded;
  const { justConnected, onConnect } = useJustConnected();
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
              factory={factory}
              apps={available}
              hasApps={hasApps}
              isAdmin={isAdmin}
              onConnect={onConnect}
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
                    <Hint label="Last event" tip={factoryHints.lastEvent} />
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {connected.map((app) => (
                  <tr key={app.id} className={justConnected(app.id) ? justConnectedRow : undefined}>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <Link to={`/apps/${app.id}`} className={link}>
                          {app.name}
                        </Link>
                        {justConnected(app.id) && <JustConnected />}
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
                          className={dangerOutlineButton}
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
            {/* w-0 min-w-full: long payload lines scroll instead of widening the columns. */}
            <pre className="max-h-96 w-0 min-w-full overflow-auto text-xs">
              {payload.data ? (payload.data.payload ?? "No longer kept.") : "Loading…"}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
