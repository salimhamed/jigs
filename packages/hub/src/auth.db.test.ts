import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { createAuth, type HubAuth, NOT_INVITED } from "./auth.ts";
import type { HubConfig } from "./config.ts";
import { connectDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { dbTest, testDatabase } from "./db/test-database.ts";

const database = testDatabase();
const db = connectDatabase(database.url);
let auth: HubAuth;

beforeAll(async () => {
  await database.create();
  await migrateDatabase(db);
  const config: HubConfig = {
    host: "127.0.0.1",
    port: 0,
    publicUrl: new URL("http://hub.test"),
    databaseUrl: database.url,
    encryptionKey: randomBytes(32),
    signInGithubClientId: "client",
    signInGithubClientSecret: "secret",
    adminEmail: "Admin@example.com",
    retentionDays: 7,
  };
  auth = createAuth(config, db);
});

afterAll(async () => {
  await db.$client.end();
  await database.drop();
});

// What the GitHub callback does once GitHub names the account's email.
async function signIn(email: string, emailVerified = true): Promise<Headers> {
  const context = await auth.$context;
  const user =
    (await context.internalAdapter.findUserByEmail(email))?.user ??
    (await context.internalAdapter.createUser(
      { email, name: email, emailVerified },
      { method: "oauth", oauth: { providerId: "github" } },
    ));
  const { token } = await context.internalAdapter.createSession(user.id);
  const cookie = context.authCookies.sessionToken.name;
  return new Headers({
    cookie: `${cookie}=${token}.${await makeSignature(token, context.secret)}`,
  });
}

const refused = { body: { code: NOT_INVITED } };

dbTest("bootstraps the admin, invites a member and keeps an admin", async () => {
  await expect(signIn("stranger@example.com")).rejects.toMatchObject(refused);
  expect(await db.select().from(schema.user)).toEqual([]);

  await expect(signIn("admin@example.com", false)).rejects.toMatchObject(refused);
  const admin = await signIn("admin@example.com");
  await expect(auth.api.getActiveMember({ headers: admin })).rejects.toThrow();
  await auth.api.createOrganization({ headers: admin, body: { name: "Acme", slug: "acme" } });
  expect(await auth.api.getActiveMember({ headers: admin })).toMatchObject({ role: "admin" });
  await expect(
    auth.api.createOrganization({ headers: admin, body: { name: "Other", slug: "other" } }),
  ).rejects.toMatchObject({ status: "FORBIDDEN" });

  await expect(
    auth.api.createInvitation({
      headers: admin,
      body: { email: "bob@example.com", role: "owner" as "admin" },
    }),
  ).rejects.toThrow("A role is admin or member, not owner.");
  const invite = await auth.api.createInvitation({
    headers: admin,
    body: { email: "Bob@example.com", role: "member" },
  });
  const week = 7 * 24 * 60 * 60 * 1000;
  expect(new Date(invite.expiresAt).getTime() - Date.now()).toBeGreaterThan(week - 60_000);

  await expect(signIn("carol@example.com")).rejects.toMatchObject(refused);
  await expect(signIn("bob@example.com", false)).rejects.toMatchObject(refused);
  const bob = await signIn("bob@example.com");
  await auth.api.acceptInvitation({ headers: bob, body: { invitationId: invite.id } });
  const bobMember = await auth.api.getActiveMember({ headers: bob });
  expect(bobMember).toMatchObject({ role: "member" });
  // A member's later sign-ins land in their Organization without an invitation.
  expect(
    await auth.api.getActiveMember({ headers: await signIn("bob@example.com") }),
  ).toMatchObject({ role: "member" });

  const adminMember = await auth.api.getActiveMember({ headers: admin });
  if (!adminMember || !bobMember) throw new Error("expected both members");
  await expect(
    auth.api.updateMemberRole({ headers: bob, body: { memberId: bobMember.id, role: "admin" } }),
  ).rejects.toMatchObject({ body: { code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER" } });
  await expect(
    auth.api.updateMemberRole({
      headers: admin,
      body: { memberId: adminMember.id, role: "member" },
    }),
  ).rejects.toMatchObject({ body: { code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER" } });
  await expect(
    auth.api.removeMember({ headers: admin, body: { memberIdOrEmail: adminMember.id } }),
  ).rejects.toMatchObject({
    body: { code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER" },
  });

  await auth.api.updateMemberRole({
    headers: admin,
    body: { memberId: bobMember.id, role: "admin" },
  });
  await auth.api.removeMember({ headers: bob, body: { memberIdOrEmail: adminMember.id } });
  await expect(signIn("admin@example.com")).rejects.toMatchObject(refused);
});

dbTest("refuses a revoked invitation", async () => {
  const bob = await signIn("bob@example.com");
  const invite = await auth.api.createInvitation({
    headers: bob,
    body: { email: "dave@example.com", role: "admin" },
  });
  await auth.api.cancelInvitation({ headers: bob, body: { invitationId: invite.id } });
  await expect(signIn("dave@example.com")).rejects.toMatchObject(refused);
});

dbTest("names the verified GitHub email an invitation was sent to", async () => {
  const bob = await signIn("bob@example.com");
  await auth.api.createInvitation({
    headers: bob,
    body: { email: "Erin@personal.example", role: "member" },
  });
  const githubUser = async (emails: { email: string; primary: boolean; verified: boolean }[]) => {
    vi.stubGlobal("fetch", async (url: string) =>
      Response.json(
        url.endsWith("/user/emails")
          ? emails
          : { id: 7, login: "erin", name: null, email: "erin@work.example", avatar_url: "" },
      ),
    );
    try {
      const github = (await auth.$context).socialProviders.find((p) => p.id === "github");
      return (await github?.getUserInfo({ accessToken: "token" }))?.user;
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const work = { email: "erin@work.example", primary: false, verified: true };

  expect(
    await githubUser([work, { email: "erin@personal.example", primary: true, verified: true }]),
  ).toMatchObject({ name: "erin", email: "erin@personal.example", emailVerified: true });
  expect(
    await githubUser([work, { email: "erin@personal.example", primary: true, verified: false }]),
  ).toMatchObject({ email: "erin@work.example", emailVerified: true });
});
