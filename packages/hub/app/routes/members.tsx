import { Trash2, X } from "lucide-react";
import { Form, useFetcher } from "react-router";
import { roles } from "../../src/roles.ts";
import { attempt, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { PageHeader } from "../components/page.tsx";
import { button, card, dangerButton, input, table } from "../components/ui.ts";
import type { Route } from "./+types/members.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { headers, user, role } = await requireMember(context, request);
  const organization = await context.auth.api.getFullOrganization({ headers });
  const now = new Date();
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
    invites: (organization?.invitations ?? [])
      .filter((invite) => invite.status === "pending" && invite.expiresAt > now)
      .map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        link: new URL(`invite/${invite.id}`, context.config.publicUrl).href,
      })),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { headers } = await requireMember(context, request);
  const form = await request.formData();
  switch (form.get("intent")) {
    case "remove":
      return attempt(() =>
        context.auth.api.removeMember({
          headers,
          body: { memberIdOrEmail: String(form.get("memberId")) },
        }),
      );
    case "role":
      return attempt(() =>
        context.auth.api.updateMemberRole({
          headers,
          body: { memberId: String(form.get("memberId")), role: String(form.get("role")) },
        }),
      );
    case "revoke":
      return attempt(() =>
        context.auth.api.cancelInvitation({
          headers,
          body: { invitationId: String(form.get("invitationId")) },
        }),
      );
    default: {
      const result = await attempt(() =>
        context.auth.api.createInvitation({
          headers,
          body: {
            email: String(form.get("email")),
            role: String(form.get("role")) as (typeof roles)[number],
          },
        }),
      );
      return result.error ? result : { message: "Invited. Copy the link below and send it." };
    }
  }
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { isAdmin, members, invites, userId } = loaderData;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Members"
        subtitle="Admins can change things. Members can look."
        action={isAdmin && <InviteForm />}
      />
      <div className={`${card} overflow-x-auto`}>
        <table className={table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                isAdmin={isAdmin}
                isYou={member.userId === userId}
              />
            ))}
          </tbody>
        </table>
      </div>
      <section className="space-y-3">
        <h2 className="font-semibold">
          Pending invites <span className="font-normal text-zinc-500">· {invites.length}</span>
        </h2>
        {invites.length === 0 ? (
          <p className="text-sm text-zinc-500">No pending invites.</p>
        ) : (
          <div className={`${card} overflow-x-auto`}>
            <table className={table}>
              <tbody>
                {invites.map((invite) => (
                  <InviteRow key={invite.id} invite={invite} isAdmin={isAdmin} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function InviteForm() {
  return (
    <div className="space-y-1.5">
      <Form method="post" className="flex flex-wrap gap-2">
        <input
          name="email"
          type="email"
          required
          placeholder="Email on their GitHub account"
          aria-label="Email"
          className={`${input} min-w-64`}
        />
        <select name="role" aria-label="Role" className={input}>
          {roles.toReversed().map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <button type="submit" className={button}>
          Invite
        </button>
      </Form>
      <p className="text-right text-sm text-zinc-500">
        The hub sends no email: you copy the link and send it.
      </p>
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
    <tr>
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
            className={dangerButton}
            onClick={() => {
              if (confirm(`Remove ${member.name} from the Organization?`)) {
                fetcher.submit({ intent: "remove", memberId: member.id }, { method: "post" });
              }
            }}
          >
            <Trash2 className="size-4" />
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function InviteRow({
  invite,
  isAdmin,
}: {
  invite: Route.ComponentProps["loaderData"]["invites"][number];
  isAdmin: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  useActionToast(fetcher.data);
  return (
    <tr>
      <td>{invite.email}</td>
      <td>{invite.role}</td>
      <td className="text-zinc-500" suppressHydrationWarning>
        Expires {new Date(invite.expiresAt).toLocaleDateString()}
      </td>
      <td>
        <div className="flex justify-end gap-1">
          <CopyButton text={invite.link} label="Link" />
          {isAdmin && (
            <button
              type="button"
              className={dangerButton}
              onClick={() =>
                fetcher.submit({ intent: "revoke", invitationId: invite.id }, { method: "post" })
              }
            >
              <X className="size-4" />
              Revoke
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
