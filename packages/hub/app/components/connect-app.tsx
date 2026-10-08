import type { Provider } from "@jigs-ai/hub-protocol";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { providerNames } from "../../src/provider-names.ts";
import { useActionToast } from "./action-toast.tsx";
import { type InstallationLabel, InstallationNames } from "./installation-names.tsx";
import { input, link, secondaryButton } from "./ui.ts";

type AvailableApp = {
  id: string;
  provider: Provider;
  name: string;
  installations: InstallationLabel[];
};

/**
 * The apps not yet connected to a factory, in a panel that filters them by
 * name. Connecting posts in the background, so the page around it stays put.
 */
export function ConnectApp({
  factory,
  apps,
  hasApps,
  isAdmin,
  onConnect,
}: {
  factory: { id: string; name: string };
  apps: AvailableApp[];
  hasApps: boolean;
  isAdmin: boolean;
  onConnect: (appId: string) => void;
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
        <p className="px-4 pb-2 text-sm text-zinc-500">Not connected to {factory.name}</p>
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
            <AppRow key={app.id} app={app} factoryId={factory.id} onConnect={onConnect} />
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

// One fetcher per app, so connecting several in quick succession never cancels one.
function AppRow({
  app,
  factoryId,
  onConnect,
}: {
  app: AvailableApp;
  factoryId: string;
  onConnect: (appId: string) => void;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  useActionToast(fetcher.data);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 grow">
        <div className="text-sm">
          {app.name} <span className="text-zinc-500">{providerNames[app.provider]}</span>
        </div>
        <InstallationNames installations={app.installations} />
      </div>
      <fetcher.Form
        method="post"
        action={`/factories/${factoryId}`}
        onSubmit={(event) => {
          (event.currentTarget.closest("[popover]") as HTMLElement | null)?.hidePopover();
          onConnect(app.id);
        }}
      >
        <input type="hidden" name="appId" value={app.id} />
        <button type="submit" name="intent" value="connect" className={secondaryButton}>
          Connect
        </button>
      </fetcher.Form>
    </li>
  );
}
