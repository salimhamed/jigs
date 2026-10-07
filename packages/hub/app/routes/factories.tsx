import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { manages } from "../../src/factories.ts";
import { requireMember } from "../auth.server.ts";
import { ReissueTokenButton, RemoveFactoryButton } from "../components/factory-confirms.tsx";
import { factoryHints } from "../components/factory-hints.ts";
import { Hint } from "../components/hint.tsx";
import { PageHeader, StatusDot, Tabs } from "../components/page.tsx";
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
  const member = await requireMember(context, request);
  const mine = new URL(request.url).searchParams.get("tab") !== "all";
  const factories = await listFactories(context, member.organizationId);
  return {
    mine,
    factories: factories
      .filter(({ createdBy }) => !mine || createdBy === member.user.id)
      .map(({ createdBy, ...factory }) => ({
        ...factory,
        canManage: manages(member, { createdBy }),
      })),
  };
}

export default function Factories({ loaderData }: Route.ComponentProps) {
  const { mine, factories } = loaderData;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Factories"
        subtitle="Services you run that act on events from the apps connected to them, such as new pull requests or Slack mentions."
        action={
          <Link to="/factories/new" className={button}>
            <Plus className="size-4" />
            Add factory
          </Link>
        }
      />
      <Tabs
        tabs={[
          { to: "?", label: "My factories", current: mine },
          { to: "?tab=all", label: "All factories", current: !mine },
        ]}
      />
      {factories.length === 0 ? (
        <p className="text-zinc-500">
          {mine ? (
            <>
              You haven't added a factory yet.{" "}
              <Link to="/factories/new" className={link}>
                Add a factory
              </Link>
              .
            </>
          ) : (
            "No factories yet."
          )}
        </p>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className={table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>
                  <Hint label="Last seen" tip={factoryHints.lastSeen} />
                </th>
                <th>
                  <Hint label="Factory version" tip={factoryHints.version} />
                </th>
                <th>
                  <Hint label="Unconfirmed events" tip={factoryHints.unconfirmed} />
                </th>
                <th>
                  <Hint label="Apps" tip={factoryHints.apps} />
                </th>
                <th>
                  <Hint
                    label="Added by"
                    tip="Who added this factory. They and admins can change it."
                  />
                </th>
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
                  <td>{factory.appNames.length}</td>
                  <td>{factory.addedBy ?? "—"}</td>
                  <td>
                    {factory.canManage && (
                      <div className="flex justify-end gap-1">
                        <ReissueTokenButton factory={factory} className={quietButton}>
                          <KeyRound className="size-4" />
                          Re-issue token
                        </ReissueTokenButton>
                        <RemoveFactoryButton factory={factory} className={dangerButton}>
                          <Trash2 className="size-4" />
                          Remove
                        </RemoveFactoryButton>
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
