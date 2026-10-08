import { CheckCircle2, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";
import { isUuid } from "../../src/apps.ts";
import { isUniqueViolation } from "../../src/db/database.ts";
import { addFactory, reissueToken } from "../../src/factories.ts";
import { providerNames } from "../../src/provider-names.ts";
import { requireFactoryManager, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { ConnectApp } from "../components/connect-app.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { InstallationNames } from "../components/installation-names.tsx";
import { PageHeader, StatusDot } from "../components/page.tsx";
import {
  button,
  card,
  input,
  link,
  quietButton,
  secondaryButton,
  table,
  warningText,
} from "../components/ui.ts";
import { connectCommand } from "../factories.server.ts";
import type { Route } from "./+types/new-factory.ts";
import type { loader as appsLoader } from "./factory-apps.ts";
import type { loader as lastSeenLoader } from "./factory-last-seen.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  await requireMember(context, request);
  return null;
}

// Re-issuing a token from another page posts here too, so both show the same connect view.
export async function action({ context, request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "reissue") {
    const factoryId = String(form.get("factoryId"));
    if (!isUuid(factoryId)) return { error: "That factory is gone." };
    const manager = await requireFactoryManager(context, request, factoryId);
    if ("error" in manager) return manager;
    const reissued = await reissueToken(
      context.db,
      context.waiters,
      manager.organizationId,
      factoryId,
    );
    if (!reissued) return { error: "That factory is gone." };
    const { token, factory } = reissued;
    return {
      connect: {
        id: factory.id,
        name: factory.name,
        command: connectCommand(context, token),
        // Stamped after re-issuing, so a poll with the old token cannot count as connecting.
        issuedAt: new Date().toISOString(),
        added: false,
      },
    };
  }
  const { organizationId, user } = await requireMember(context, request);
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name the factory." };
  try {
    const { factory, token } = await addFactory(context.db, organizationId, name, user.id);
    return {
      connect: {
        id: factory.id,
        name,
        command: connectCommand(context, token),
        issuedAt: new Date().toISOString(),
        added: true,
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `A factory is already named ${name}.` };
    throw error;
  }
}

export default function NewFactory({ actionData }: Route.ComponentProps) {
  const connect = actionData && "connect" in actionData ? actionData.connect : undefined;
  useActionToast(actionData && "error" in actionData ? actionData : undefined);
  if (connect) return <ConnectFactory key={connect.command} factory={connect} />;
  return (
    <div className="space-y-6">
      <PageHeader title="Add a factory" parent={{ to: "/factories", label: "Factories" }} />
      <Form method="post" className="max-w-xl space-y-4">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input name="name" required autoComplete="off" className={input} />
          <span className="text-zinc-500">Shown in the factory list. You can rename it later.</span>
        </label>
        <div className="flex gap-2">
          <button type="submit" className={button}>
            Create and get command
          </button>
          <Link to="/factories" className={quietButton}>
            Cancel
          </Link>
        </div>
      </Form>
    </div>
  );
}

const CHECK_EVERY_MS = 5_000;

const UP_COMMAND = "pnpm exec jigs up";

/**
 * Setting a factory up: connecting its apps when it is new, the one-time
 * connect command, and starting it, then whether it has connected yet.
 */
function ConnectFactory({
  factory,
}: {
  factory: { id: string; name: string; command: string; issuedAt: string; added: boolean };
}) {
  const lastSeen = useFetcher<typeof lastSeenLoader>();
  const url = `/factories/${factory.id}/last-seen`;
  const lastSeenAt = lastSeen.data?.lastSeenAt;
  const connected = lastSeenAt != null && lastSeenAt > factory.issuedAt;
  const gone = lastSeen.data?.gone === true;
  const done = connected || gone;
  const [now, setNow] = useState(Date.now);
  const [nextCheck, setNextCheck] = useState(() => Date.now() + CHECK_EVERY_MS);
  const { load } = lastSeen;

  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [done]);

  useEffect(() => {
    if (done || now < nextCheck) return;
    load(url);
    setNextCheck(now + CHECK_EVERY_MS);
  }, [done, now, nextCheck, load, url]);

  const checkNow = () => {
    load(url);
    setNextCheck(Date.now() + CHECK_EVERY_MS);
  };

  let step = 0;
  return (
    <div className="space-y-8">
      <PageHeader
        title={`Connect ${factory.name}`}
        parent={{ to: "/factories", label: "Factories" }}
      />
      <ol className="max-w-3xl space-y-8">
        {factory.added && (
          <Step
            number={++step}
            title="Connect the apps it uses"
            description="The factory hears events from these apps and acts through them. You can change them later on its page."
          >
            <FactoryApps factory={factory} />
          </Step>
        )}
        <Step
          number={++step}
          title="Point it at this hub"
          description={
            <>
              Run this in the directory of <strong>{factory.name}</strong>, on the machine where it
              runs.
            </>
          }
        >
          <Command text={factory.command} />
          <p className={`text-sm ${warningText}`}>
            The token is shown once. Copy it before leaving this page.
          </p>
        </Step>
        <Step
          number={++step}
          title="Start it"
          description={
            <>
              Its last check, doctor, flags any app the factory uses that isn't installed, named or
              connected to it yet. Fix that in the hub, then run <code>pnpm exec jigs doctor</code>.
            </>
          }
        >
          <Command text={UP_COMMAND} />
          {gone ? (
            <p className={`text-sm ${warningText}`}>This factory was removed.</p>
          ) : connected ? (
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="size-4 text-emerald-500" />
              {factory.name} is connected.
              <Link to={`/factories/${factory.id}`} className={link}>
                Open its page
              </Link>
            </p>
          ) : (
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              <StatusDot online={false} />
              Waiting for {factory.name} to connect…
              <button type="button" onClick={checkNow} className={quietButton}>
                <RefreshCw
                  className={`size-4 ${lastSeen.state === "loading" ? "animate-spin" : ""}`}
                />
                Check now ({Math.max(0, Math.ceil((nextCheck - now) / 1000))}s)
              </button>
            </div>
          )}
        </Step>
      </ol>
      <Link to="/factories" className={secondaryButton}>
        Back to factories
      </Link>
    </div>
  );
}

function Step({
  number,
  title,
  description,
  children,
}: {
  number: number;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-sm font-medium dark:border-zinc-700">
        {number}
      </span>
      <div className="min-w-0 grow space-y-3 pt-0.5">
        <div className="space-y-1">
          <h2 className="font-semibold">{title}</h2>
          <p className="text-sm text-zinc-500">{description}</p>
        </div>
        {children}
      </div>
    </li>
  );
}

function Command({ text }: { text: string }) {
  return (
    <div className={`${card} flex items-center gap-3 p-3`}>
      <code className="grow break-all text-sm">
        <span className="select-none text-zinc-500">$ </span>
        {text}
      </code>
      <CopyButton text={text} label="Command" />
    </div>
  );
}

/** The factory's connected apps, with the panel to connect more. */
function FactoryApps({ factory }: { factory: { id: string; name: string } }) {
  const apps = useFetcher<typeof appsLoader>();
  const { load } = apps;
  useEffect(() => {
    load(`/factories/${factory.id}/apps`);
  }, [load, factory.id]);
  const [justConnected, setJustConnected] = useState<string[]>([]);
  const loaded = apps.data;
  if (!loaded) return <p className="text-sm text-zinc-500">Loading apps…</p>;
  if (loaded.gone) return null;
  return (
    <div className="space-y-3">
      <ConnectApp
        factory={factory}
        apps={loaded.available}
        hasApps={loaded.hasApps}
        isAdmin={loaded.isAdmin}
        onConnect={(appId) => setJustConnected((ids) => [...ids, appId])}
      />
      {loaded.connected.length === 0 ? (
        <p className="text-sm text-zinc-500">No apps connected yet.</p>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className={table}>
            <thead>
              <tr>
                <th>App</th>
                <th>Provider</th>
                <th>Installations</th>
              </tr>
            </thead>
            <tbody>
              {loaded.connected.map((app) => (
                <tr
                  key={app.id}
                  className={
                    justConnected.includes(app.id)
                      ? "bg-emerald-50 dark:bg-emerald-950/40"
                      : undefined
                  }
                >
                  <td>
                    <span className="flex items-center gap-2.5">
                      {app.name}
                      {justConnected.includes(app.id) && (
                        <span className="text-emerald-600 dark:text-emerald-400">Connected</span>
                      )}
                    </span>
                  </td>
                  <td className="text-zinc-500">{providerNames[app.provider]}</td>
                  <td>
                    <InstallationNames installations={app.installations} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
