import { X } from "lucide-react";
import { Form, useFetcher } from "react-router";
import { roles } from "../../src/roles.ts";
import { attempt, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { button, input, quietButton, table } from "../components/ui.ts";
import type { Route } from "./+types/invites.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { headers, role } = await requireMember(context, request);
  const organization = await context.auth.api.getFullOrganization({ headers });
  const now = new Date();
  return {
    isAdmin: role === "admin",
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
  if (form.get("intent") === "revoke") {
    return attempt(() =>
      context.auth.api.cancelInvitation({
        headers,
        body: { invitationId: String(form.get("invitationId")) },
      }),
    );
  }
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

export default function Invites({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Invites</h1>
      {loaderData.isAdmin && (
        <div className="space-y-2">
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
          <p className="text-sm text-zinc-500">
            The hub sends no email: copy the invite link and send it yourself.
          </p>
        </div>
      )}
      {loaderData.invites.length === 0 ? (
        <p className="text-zinc-500">No pending invites.</p>
      ) : (
        <table className={table}>
          <thead className="text-zinc-500">
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loaderData.invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} isAdmin={loaderData.isAdmin} />
            ))}
          </tbody>
        </table>
      )}
    </div>
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
    <tr className="border-t border-zinc-200 dark:border-zinc-800">
      <td>{invite.email}</td>
      <td>{invite.role}</td>
      <td>{new Date(invite.expiresAt).toLocaleDateString()}</td>
      <td className="flex justify-end gap-1">
        <CopyButton text={invite.link} label="Link" />
        {isAdmin && (
          <button
            type="button"
            className={quietButton}
            onClick={() =>
              fetcher.submit({ intent: "revoke", invitationId: invite.id }, { method: "post" })
            }
          >
            <X className="size-4" />
            Revoke
          </button>
        )}
      </td>
    </tr>
  );
}
