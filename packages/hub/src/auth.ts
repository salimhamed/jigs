import { hkdfSync } from "node:crypto";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import type { OAuth2Tokens } from "better-auth/oauth2";
import { organization } from "better-auth/plugins";
import { adminAc, memberAc } from "better-auth/plugins/organization/access";
import type { GithubProfile } from "better-auth/social-providers";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { HubConfig } from "./config.ts";
import type { HubDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { roles } from "./roles.ts";

/** The error code a refused sign-in comes back with, as `?error=`. */
export const NOT_INVITED = "NOT_INVITED";

export type HubAuth = ReturnType<typeof createAuth>;

/** Better Auth for the hub: GitHub sign-in, invite-only, with Organizations, members and invites. */
export function createAuth(config: HubConfig, db: HubDatabase) {
  // An unverified email could claim someone else's invitation or the admin email.
  const mayEnter = async (user: Person & { id?: string }) => {
    if (!user.emailVerified) return false;
    if (user.id && (await firstOrganizationId(db, user.id))) return true;
    const invited = await db.query.invitation.findFirst({
      where: and(eq(schema.invitation.email, user.email.toLowerCase()), pendingInvitation()),
    });
    if (invited) return true;
    return mayCreateOrganization(config, db, user);
  };
  const refuse = () => {
    throw new APIError("FORBIDDEN", {
      code: NOT_INVITED,
      message: "This hub is invite-only.",
    });
  };
  const checkRole = (role: string) => {
    if (!(roles as readonly string[]).includes(role)) {
      throw new APIError("BAD_REQUEST", { message: `A role is admin or member, not ${role}.` });
    }
  };

  return betterAuth({
    baseURL: config.publicUrl.href,
    // One key to keep: the session secret comes from the encryption key.
    secret: Buffer.from(hkdfSync("sha256", config.encryptionKey, "", "jigs hub auth", 32)).toString(
      "base64",
    ),
    database: drizzleAdapter(db, { provider: "pg", schema }),
    telemetry: { enabled: false },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      github: {
        clientId: config.signInGithubClientId,
        clientSecret: config.signInGithubClientSecret,
        getUserInfo: (token) => githubUser(db, token),
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await mayEnter(user))) refuse();
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await db.query.user.findFirst({
              where: eq(schema.user.id, session.userId),
            });
            if (!user || !(await mayEnter(user))) refuse();
            return {
              data: {
                ...session,
                activeOrganizationId: await firstOrganizationId(db, session.userId),
              },
            };
          },
        },
      },
    },
    hooks: {
      // The web app calls the Organization endpoints server-side, behind the hub's own role
      // checks. Over HTTP they would hand any member what only admins may see, such as invite
      // links. Only an HTTP call carries a request.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.request && ctx.path.startsWith("/organization/")) throw new APIError("NOT_FOUND");
      }),
    },
    plugins: [
      organization({
        creatorRole: "admin",
        roles: { admin: adminAc, member: memberAc },
        disableOrganizationDeletion: true,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        requireEmailVerificationOnInvitation: true,
        allowUserToCreateOrganization: (user) => mayCreateOrganization(config, db, user),
        organizationHooks: {
          beforeCreateInvitation: async ({ invitation }) => checkRole(invitation.role),
          beforeUpdateMemberRole: async ({ newRole }) => checkRole(newRole),
        },
      }),
    ],
  });
}

// GitHub sign-in names the profile's public email, else the primary one. An invitation may name
// any verified email on the account, so the one with a pending invitation comes first.
async function githubUser(db: HubDatabase, { accessToken }: OAuth2Tokens) {
  const headers = { authorization: `Bearer ${accessToken}`, "user-agent": "hub" };
  const [profileResponse, emailsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch("https://api.github.com/user/emails", { headers }),
  ]);
  if (!profileResponse.ok || !emailsResponse.ok) return null;
  const profile = (await profileResponse.json()) as GithubProfile;
  const emails = (await emailsResponse.json()) as {
    email: string;
    primary: boolean;
    verified: boolean;
  }[];
  const verified = emails.filter((e) => e.verified).map((e) => e.email.toLowerCase());
  const invited = await db.query.invitation.findFirst({
    columns: { email: true },
    where: and(inArray(schema.invitation.email, verified), pendingInvitation()),
  });
  const email = invited?.email ?? profile.email ?? emails.find((e) => e.primary)?.email;
  if (!email) return null;
  return {
    user: {
      name: profile.name || profile.login,
      email,
      image: profile.avatar_url,
      emailVerified: verified.includes(email.toLowerCase()),
    },
    data: profile,
  };
}

type Person = { email: string; emailVerified?: boolean | null };

/** Only the first admin creates an Organization, and only before the hub has one. */
export async function mayCreateOrganization(config: HubConfig, db: HubDatabase, user: Person) {
  if (!user.emailVerified) return false;
  if (user.email.toLowerCase() !== config.adminEmail.toLowerCase()) return false;
  return (await db.query.organization.findFirst({ columns: { id: true } })) === undefined;
}

/** Matches an invitation that can still be accepted. */
export function pendingInvitation() {
  return and(eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date()));
}

async function firstOrganizationId(db: HubDatabase, userId: string) {
  const member = await db.query.member.findFirst({
    columns: { organizationId: true },
    where: eq(schema.member.userId, userId),
  });
  return member?.organizationId ?? null;
}

/** The Organization the signed-in user of these headers is an admin of, or `null`. */
export async function adminOrganization(auth: HubAuth, headers: Headers): Promise<string | null> {
  try {
    const member = await auth.api.getActiveMember({ headers });
    return member?.role === "admin" ? member.organizationId : null;
  } catch (error) {
    if (error instanceof APIError) return null;
    throw error;
  }
}
