import { and, eq } from "drizzle-orm";
import { Trash2, UserPlus, X } from "lucide-react";
import { data, Link, useFetcher } from "react-router";
import * as schema from "../../src/db/schema.ts";
import { roles } from "../../src/roles.ts";
import { attempt, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { ConfirmForm } from "../components/confirm-form.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { PageHeader } from "../components/page.tsx";
import { button, card, dangerButton, select, table } from "../components/ui.ts";
import type { Route } from "./+types/members.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { headers, user, role } = await requireMember(context, request);
  const organization = await context.auth.api.getFullOrganization({ headers });
  const now = new Date();
  const isAdmin = role === "admin";
  return {
    isAdmin,
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
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        // An invite's id is its link, which only admins may share or revoke.
        admin: isAdmin
          ? {
              id: invite.id,
              link: new URL(`invite/${invite.id}`, context.config.publicUrl).href,
            }
          : null,
      })),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { headers, organizationId } = await requireMember(context, request);
  const form = await request.formData();
  switch (form.get("intent")) {
    case "remove":
      return attempt(() =>
        context.auth.api.removeMember({
          headers,
          body: { memberIdOrEmail: String(form.get("memberId")) },
        }),
      );
    case "role": {
      const memberId = String(form.get("memberId"));
      const role = String(form.get("role"));
      const result = await attempt(() =>
        context.auth.api.updateMemberRole({ headers, body: { memberId, role } }),
      );
      if (result.error) return result;
      const [changed] = await context.db
        .select({ name: schema.user.name })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(
          and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)),
        );
      return { message: `${changed?.name} is now ${role === "admin" ? "an admin" : "a member"}.` };
    }
    case "revoke":
      return attempt(() =>
        context.auth.api.cancelInvitation({
          headers,
          body: { invitationId: String(form.get("invitationId")) },
        }),
      );
    default:
      throw data(null, { status: 400, statusText: "Bad Request" });
  }
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  const { isAdmin, members, invites, userId } = loaderData;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Members"
        subtitle="Admins manage apps, members, settings and every factory. Members can see everything, and add and manage their own factories."
        action={
          isAdmin && (
            <Link to="/members/invite" className={button}>
              <UserPlus className="size-4" />
              Invite member
            </Link>
          )
        }
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
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <InviteRow key={`${invite.email} ${invite.expiresAt}`} invite={invite} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
            className={select}
            onChange={(event) =>
              fetcher.submit(
                {
                  intent: "role",
                  memberId: member.id,
                  role: event.target.value,
                },
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
        {isAdmin && !isYou && (
          <ConfirmForm
            fields={{ intent: "remove", memberId: member.id }}
            title={`Remove ${member.name}?`}
            body={`${member.name} loses access to this hub. Invite them again to let them back in.`}
            confirmLabel="Remove member"
            destructive
            className={dangerButton}
          >
            <Trash2 className="size-4" />
            Remove
          </ConfirmForm>
        )}
      </td>
    </tr>
  );
}

function InviteRow({ invite }: { invite: Route.ComponentProps["loaderData"]["invites"][number] }) {
  const { admin } = invite;
  return (
    <tr>
      <td>{invite.email}</td>
      <td>{invite.role}</td>
      <td className="text-zinc-500" suppressHydrationWarning>
        {new Date(invite.expiresAt).toLocaleDateString()}
      </td>
      <td>
        {admin && (
          <div className="flex justify-end gap-1">
            <CopyButton text={admin.link} label="Link" />
            <ConfirmForm
              fields={{ intent: "revoke", invitationId: admin.id }}
              title={`Revoke the invite for ${invite.email}?`}
              body="Its link stops working. You can invite them again later."
              confirmLabel="Revoke invite"
              destructive
              className={dangerButton}
            >
              <X className="size-4" />
              Revoke
            </ConfirmForm>
          </div>
        )}
      </td>
    </tr>
  );
}
