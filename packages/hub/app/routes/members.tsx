import { Trash2 } from "lucide-react";
import { useFetcher } from "react-router";
import { roles } from "../../src/roles.ts";
import { attempt, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { input, quietButton, table } from "../components/ui.ts";
import type { Route } from "./+types/members.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { headers, user, role } = await requireMember(context, request);
  const organization = await context.auth.api.getFullOrganization({ headers });
  return {
    isAdmin: role === "admin",
    userId: user.id,
    members: (organization?.members ?? []).map((member) => ({
      id: member.id,
      userId: member.userId,
      role: member.role,
      name: member.user.name,
      email: member.user.email,
    })),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { headers } = await requireMember(context, request);
  const form = await request.formData();
  const memberId = String(form.get("memberId"));
  if (form.get("intent") === "remove") {
    return attempt(() =>
      context.auth.api.removeMember({ headers, body: { memberIdOrEmail: memberId } }),
    );
  }
  return attempt(() =>
    context.auth.api.updateMemberRole({
      headers,
      body: { memberId, role: String(form.get("role")) },
    }),
  );
}

export default function Members({ loaderData }: Route.ComponentProps) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Members</h1>
      <table className={table}>
        <thead className="text-zinc-500">
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {loaderData.members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              isAdmin={loaderData.isAdmin}
              isYou={member.userId === loaderData.userId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({
  member,
  isAdmin,
  isYou,
}: {
  member: Route.ComponentProps["loaderData"]["members"][number];
  isAdmin: boolean;
  isYou: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  return (
    <tr className="border-t border-zinc-200 dark:border-zinc-800">
      <td>
        {member.name}
        {isYou && <span className="text-zinc-500"> (you)</span>}
      </td>
      <td>{member.email}</td>
      <td>
        {isAdmin ? (
          <select
            aria-label={`Role of ${member.email}`}
            value={member.role}
            className={input}
            onChange={(event) =>
              fetcher.submit(
                { intent: "role", memberId: member.id, role: event.target.value },
                { method: "post" },
              )
            }
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        ) : (
          member.role
        )}
      </td>
      <td className="text-right">
        {isAdmin && (
          <button
            type="button"
            className={quietButton}
            onClick={() =>
              fetcher.submit({ intent: "remove", memberId: member.id }, { method: "post" })
            }
          >
            <Trash2 className="size-4" />
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}
