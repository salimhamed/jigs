import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { requireMember } from "../auth.server.ts";
import { ConfirmForm } from "../components/confirm-form.tsx";
import { PageHeader, StatusDot } from "../components/page.tsx";
import { TimeAgo } from "../components/time.tsx";
import {
  button,
  card,
  dangerButton,
  link,
  quietButton,
  table,
  warningText,
} from "../components/ui.ts";
import { listFactories } from "../factories.server.ts";
import type { Route } from "./+types/factories.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { organizationId, role } = await requireMember(context, request);
  return {
    isAdmin: role === "admin",
    factories: await listFactories(context, organizationId),
  };
}

export default function Factories({ loaderData }: Route.ComponentProps) {
  const { isAdmin, factories } = loaderData;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Factories"
        subtitle="jigs services that pull events from this hub."
        action={
          isAdmin && (
            <Link to="/factories/new" className={button}>
              <Plus className="size-4" />
              Add factory
            </Link>
          )
        }
      />
      {factories.length === 0 ? (
        <p className="text-zinc-500">No factories yet.</p>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className={table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Last seen</th>
                <th>jigs</th>
                <th>Unconfirmed</th>
                <th>Apps</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {factories.map((factory) => (
                <tr key={factory.id}>
                  <td>
                    <span className="flex items-center gap-2.5">
                      <StatusDot online={factory.online} />
                      <Link to={`/factories/${factory.id}`} className={link}>
                        {factory.name}
                      </Link>
                    </span>
                  </td>
                  <td>{factory.lastSeenAt ? <TimeAgo iso={factory.lastSeenAt} /> : "never"}</td>
                  <td className="font-mono">{factory.lastSeenVersion ?? "—"}</td>
                  <td className={factory.unconfirmed > 0 ? warningText : undefined}>
                    {factory.unconfirmed}
                  </td>
                  <td>{factory.apps}</td>
                  <td>
                    {isAdmin && (
                      <div className="flex justify-end gap-1">
                        <ConfirmForm
                          action="/factories/new"
                          fields={{ intent: "reissue", factoryId: factory.id }}
                          question={`Re-issue the token of ${factory.name}? Its current token stops working.`}
                          className={quietButton}
                        >
                          <KeyRound className="size-4" />
                          Re-issue token
                        </ConfirmForm>
                        <ConfirmForm
                          action={`/factories/${factory.id}`}
                          fields={{ intent: "remove" }}
                          question={`Remove ${factory.name} and every message waiting for it?`}
                          className={dangerButton}
                        >
                          <Trash2 className="size-4" />
                          Remove
                        </ConfirmForm>
                      </div>
                    )}
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
