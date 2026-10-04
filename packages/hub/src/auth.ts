import { hkdfSync } from "node:crypto";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { adminAc, memberAc } from "better-auth/plugins/organization/access";
import { and, eq, gt } from "drizzle-orm";
import type { HubConfig } from "./config.ts";
import type { HubDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { roles } from "./roles.ts";

/** The error code a refused sign-in comes back with, as `?error=`. */
export const NOT_INVITED = "NOT_INVITED";

export type HubAuth = ReturnType<typeof createAuth>;

/** Better Auth for the hub: GitHub sign-in, invite-only, with Organizations, members and invites. */
export function createAuth(config: HubConfig, db: HubDatabase) {
  const mayEnter = async (email: string, userId?: string) => {
    if (userId && (await firstOrganizationId(db, userId))) return true;
    const invited = await db.query.invitation.findFirst({
      where: and(
        eq(schema.invitation.email, email.toLowerCase()),
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    });
    if (invited) return true;
    return mayCreateOrganization(config, db, email);
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
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await mayEnter(user.email))) refuse();
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await db.query.user.findFirst({
              where: eq(schema.user.id, session.userId),
            });
            if (!user || !(await mayEnter(user.email, user.id))) refuse();
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
    plugins: [
      organization({
        creatorRole: "admin",
        roles: { admin: adminAc, member: memberAc },
        disableOrganizationDeletion: true,
        allowUserToCreateOrganization: (user) => mayCreateOrganization(config, db, user.email),
        organizationHooks: {
          beforeCreateInvitation: async ({ invitation }) => checkRole(invitation.role),
          beforeUpdateMemberRole: async ({ newRole }) => checkRole(newRole),
        },
      }),
    ],
  });
}

/** Only the first admin creates an Organization, and only before the hub has one. */
export async function mayCreateOrganization(config: HubConfig, db: HubDatabase, email: string) {
  if (email.toLowerCase() !== config.adminEmail.toLowerCase()) return false;
  return (await db.query.organization.findFirst({ columns: { id: true } })) === undefined;
}

async function firstOrganizationId(db: HubDatabase, userId: string) {
  const member = await db.query.member.findFirst({
    columns: { organizationId: true },
    where: eq(schema.member.userId, userId),
  });
  return member?.organizationId ?? null;
}
