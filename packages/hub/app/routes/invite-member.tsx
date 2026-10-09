import { Form, Link } from "react-router";
import { type Role, roleLabels, roles } from "../../src/roles.ts";
import { attempt, requireAdmin, requireMember } from "../auth.server.ts";
import { useActionToast } from "../components/action-toast.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { PageHeader } from "../components/page.tsx";
import { button, card, input, quietButton, secondaryButton } from "../components/ui.ts";
import type { Route } from "./+types/invite-member.ts";

export async function loader({ context, request }: Route.LoaderArgs) {
  const { role } = await requireMember(context, request);
  return { isAdmin: role === "admin" };
}

export async function action({ context, request }: Route.ActionArgs) {
  const admin = await requireAdmin(context, request);
  if ("error" in admin) return admin;
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const role = String(form.get("role")) as Role;
  let invitation: { id: string; expiresAt: Date } | undefined;
  const result = await attempt(async () => {
    invitation = await context.auth.api.createInvitation({
      headers: admin.headers,
      body: { email, role },
    });
  });
  if (result.error || !invitation) return { error: result.error ?? "No invite was created." };
  return {
    invite: {
      email,
      link: new URL(`invite/${invitation.id}`, context.config.publicUrl).href,
      expiresAt: new Date(invitation.expiresAt).toISOString(),
    },
  };
}

const roleChoices: Record<Role, string> = {
  member: "Can see everything, and add and manage their own factories",
  admin: "Can also manage apps, members, settings and every factory",
};

export default function InviteMember({ loaderData, actionData }: Route.ComponentProps) {
  useActionToast(actionData && "error" in actionData ? actionData : undefined);
  const invite = actionData && "invite" in actionData ? actionData.invite : undefined;
  if (invite) return <InviteLink key={invite.link} invite={invite} />;
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="Invite a member"
        subtitle="The hub doesn't send email. You'll get a link to send them yourself. They sign in with GitHub, so use the email on their GitHub account."
        parent={{ to: "/members", label: "Members" }}
      />
      {loaderData.isAdmin ? (
        <Form method="post" className="space-y-5">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Email</span>
            <input
              name="email"
              type="email"
              required
              placeholder="name@company.com"
              className={input}
            />
          </label>
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm font-medium">Role</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {roles.toReversed().map((role) => (
                <label
                  key={role}
                  className={`${card} cursor-pointer p-4 has-focus-visible:ring-2 has-focus-visible:ring-zinc-400 has-checked:border-zinc-900 has-checked:bg-zinc-50 dark:has-checked:border-zinc-100 dark:has-checked:bg-zinc-900`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={role}
                    defaultChecked={role === "member"}
                    className="sr-only"
                  />
                  <span className="block font-medium">{roleLabels[role]}</span>
                  <span className="block text-sm text-zinc-500">{roleChoices[role]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <button type="submit" className={button}>
              Create invite link
            </button>
            <Link to="/members" className={quietButton}>
              Cancel
            </Link>
          </div>
        </Form>
      ) : (
        <p className="text-zinc-500">Only an admin can invite people.</p>
      )}
    </div>
  );
}

function InviteLink({ invite }: { invite: { email: string; link: string; expiresAt: string } }) {
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={`Invite link for ${invite.email}`}
        subtitle={`Send this link to ${invite.email}. It works once and expires on ${new Date(
          invite.expiresAt,
        ).toLocaleDateString()}. You can copy it again from Pending invites.`}
        parent={{ to: "/members", label: "Members" }}
      />
      <div className={`${card} flex items-center gap-3 p-3`}>
        <code className="grow break-all text-sm">{invite.link}</code>
        <CopyButton text={invite.link} label="Link" />
      </div>
      <div className="flex gap-2">
        <Link to="/members" className={secondaryButton}>
          Back to members
        </Link>
        <Link to="/members/invite" className={quietButton}>
          Invite another
        </Link>
      </div>
    </div>
  );
}
