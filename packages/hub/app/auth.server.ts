import { APIError } from "better-auth/api";
import { and, eq, gt } from "drizzle-orm";
import { type AppLoadContext, redirect } from "react-router";
import { mayCreateOrganization } from "../src/auth.ts";
import { invitation, organization } from "../src/db/schema.ts";
import type { Role } from "../src/roles.ts";

/** The signed-in user, or `null`. */
export async function getSession(context: AppLoadContext, request: Request) {
  return context.auth.api.getSession({ headers: request.headers });
}

/** The signed-in user's membership of their Organization, or `null`. */
export async function getActiveMember(context: AppLoadContext, request: Request) {
  try {
    return await context.auth.api.getActiveMember({ headers: request.headers });
  } catch (error) {
    if (error instanceof APIError) return null;
    throw error;
  }
}

/**
 * The signed-in member of an Organization. Sends anyone signed out to sign in,
 * and anyone outside an Organization to create one or learn they are not in one.
 */
export async function requireMember(context: AppLoadContext, request: Request) {
  const { headers } = request;
  const session = await getSession(context, request);
  if (!session) throw redirect("/sign-in");
  const member = await getActiveMember(context, request);
  if (!member) throw redirect("/new-organization");
  return {
    headers,
    user: session.user,
    organizationId: member.organizationId,
    role: member.role as Role,
  };
}

/** Run a Better Auth call for an action, returning its refusal as `{ error }`. */
export async function attempt(call: () => Promise<unknown>): Promise<{ error?: string }> {
  try {
    await call();
    return {};
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    return {
      error: lastAdmin.has(error.body?.code ?? "") ? "Keep at least one admin." : error.message,
    };
  }
}

// The plugin calls the creator's role "owner"; the hub's creator role is admin.
const lastAdmin = new Set([
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
]);

/** Start GitHub sign-in. A refusal comes back to `errorCallbackURL` with `?error=<code>`. */
export async function signInWithGitHub(
  context: AppLoadContext,
  urls: { callbackURL: string; errorCallbackURL: string },
) {
  const { headers, response } = await context.auth.api.signInSocial({
    body: { provider: "github", ...urls },
    returnHeaders: true,
  });
  if (!response.url) throw new Error("GitHub sign-in returned no URL");
  return redirect(response.url, { headers });
}

/** Whether this user may create the hub's first Organization. */
export function mayCreate(context: AppLoadContext, email: string) {
  return mayCreateOrganization(context.config, context.db, email);
}

/** A pending invitation and the name of its Organization, or `null`. */
export async function findPendingInvitation(context: AppLoadContext, id: string) {
  const [invite] = await context.db
    .select({ role: invitation.role, organization: organization.name })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(
      and(
        eq(invitation.id, id),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    );
  return invite ? { role: invite.role as Role, organization: invite.organization } : null;
}
