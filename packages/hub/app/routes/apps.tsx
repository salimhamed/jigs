import { Plus } from "lucide-react";
import { Link } from "react-router";
import { providerNames } from "../../src/provider-names.ts";
import { listApps } from "../apps.server.ts";
import { requireMember } from "../auth.server.ts";
import { PageHeader } from "../components/page.tsx";
import { button, card, link, table, warningText } from "../components/ui.ts";
import type { Route } from "./+types/apps.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  return { isAdmin: role === "admin", apps: await listApps(context, organizationId) };
}

export default function Apps({ loaderData }: Route.ComponentProps) {
  const { isAdmin, apps } = loaderData;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        subtitle="Your Organization's identity on each provider."
        action={
          isAdmin && (
            <Link to="/apps/new" className={button}>
              <Plus className="size-4" />
              Add app
            </Link>
          )
        }
      />
      {apps.length === 0 ? (
        <p className="text-zinc-500">No apps yet.</p>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className={table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Provider</th>
                <th>Installed on</th>
                <th>Factories</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id}>
                  <td>
                    <Link to={`/apps/${app.id}`} className={link}>
                      {app.name}
                    </Link>
                  </td>
                  <td className="text-zinc-500">{providerNames[app.provider]}</td>
                  <td>
                    {app.installations.length === 0
                      ? "—"
                      : app.installations.map((installation, index) => (
                          <span key={installation.account}>
                            {index > 0 && ", "}
                            {installation.installationName ?? (
                              <span className={warningText}>needs a name</span>
                            )}{" "}
                            <span className="text-zinc-500">({installation.account})</span>
                          </span>
                        ))}
                  </td>
                  <td>{app.factories}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
