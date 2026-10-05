import { Check } from "lucide-react";
import { data, Link } from "react-router";
import { isUuid } from "../../src/apps.ts";
import { assignedApps } from "../apps.server.ts";
import { requireMember } from "../auth.server.ts";
import { Time } from "../components/time.tsx";
import { table } from "../components/ui.ts";
import { readEventLog } from "../factories.server.ts";
import type { Route } from "./+types/factory.ts";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  const { organizationId } = await requireMember(context, request);
  const before = new URL(request.url).searchParams.get("before");
  const log = isUuid(params.id)
    ? await readEventLog(
        context,
        organizationId,
        params.id,
        before && /^\d{1,19}$/.test(before) ? BigInt(before) : null,
      )
    : null;
  if (!log) throw data(null, { status: 404, statusText: "Not Found" });
  return { ...log, apps: await assignedApps(context, params.id), paged: before !== null };
}

export default function Factory({ loaderData }: Route.ComponentProps) {
  const { name, apps, messages, older, paged } = loaderData;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{name}</h1>
      <p className="text-sm">
        <span className="text-zinc-500">Apps: </span>
        {apps.length === 0
          ? "none, so it receives no provider events"
          : apps.map((app, index) => (
              <span key={app.id}>
                {index > 0 && ", "}
                <Link to={`/apps/${app.id}`} className="underline">
                  {app.name}
                </Link>
              </span>
            ))}
      </p>
      <p className="text-sm text-zinc-500">
        The provider events sent to this factory, newest first.
      </p>
      {messages.length === 0 ? (
        <p className="text-zinc-500">No messages.</p>
      ) : (
        <table className={`${table} [&_td]:align-top`}>
          <thead className="text-zinc-500">
            <tr>
              <th>Position</th>
              <th>Provider</th>
              <th>Event</th>
              <th>Received</th>
              <th>Confirmed</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((message) => (
              <tr key={message.position} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="tabular-nums">{message.position}</td>
                <td>{message.provider ?? "—"}</td>
                <td>
                  {message.kind === "fellBehind" ? (
                    <span className="text-zinc-500">fell behind</span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer">{message.name}</summary>
                      <pre className="mt-2 max-h-96 max-w-xl overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-900">
                        {message.payload}
                      </pre>
                    </details>
                  )}
                </td>
                <td>
                  <Time iso={message.receivedAt} />
                </td>
                <td>{message.confirmed && <Check aria-label="Confirmed" className="size-4" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex gap-4 text-sm">
        {paged && (
          <Link to="?" className="underline">
            Newest
          </Link>
        )}
        {older && (
          <Link to={`?before=${older}`} className="underline">
            Older
          </Link>
        )}
      </div>
    </div>
  );
}
