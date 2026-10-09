// Every hub table. After changing this file, run
// `pnpm --filter @jigs-ai/hub db:generate --name <change>` and commit the SQL.

// Better Auth's tables, with the organization plugin's: what `npx auth generate`
// writes for the options in ../auth.ts.
import type { MessageKind, Provider } from "@jigs-ai/hub-protocol";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

/** A factory of an Organization, which reads its messages with its token. */
export const factories = pgTable(
  "factories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * Who added the factory: while a member, they may change it, as admins may.
     * `null` for a factory added before the hub recorded this, or once the user
     * is deleted; only admins change those.
     */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSeenVersion: text("last_seen_version"),
    /** The position of the last message the factory confirmed. */
    cursor: bigint("cursor", { mode: "bigint" }).default(sql`0`).notNull(),
  },
  (table) => [unique("factories_organization_name").on(table.organizationId, table.name)],
);

/** An Organization's own identity on a provider, such as a GitHub App. */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").$type<Provider>().notNull(),
    name: text("name").notNull(),
    /** The provider's id for the app, which its provider events carry, such as a GitHub App ID. */
    externalId: text("external_id").notNull(),
    /** What the provider's own settings show, such as a GitHub App's client ID. */
    settings: jsonb("settings").notNull(),
    /** The app's secrets as JSON, encrypted with `encryptJson`. */
    secrets: text("secrets").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("apps_provider_external_id").on(table.provider, table.externalId),
    // The target of installations' foreign key, which carries the Organization along.
    unique("apps_id_organization").on(table.id, table.organizationId),
  ],
);

/** Where an app is installed, such as a GitHub account or a Linear workspace. */
export const installations = pgTable(
  "installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").notNull(),
    /** The app's Organization, kept here so installation names are unique within it. */
    organizationId: text("organization_id").notNull(),
    /** The provider's id for the installation. */
    externalId: text("external_id").notNull(),
    /** The name factories use for the installation, which an admin sets; `null` until then. */
    installationName: text("installation_name"),
    /** The account or workspace the app is installed on, such as a GitHub login or a Linear URL key. */
    account: text("account").notNull(),
    /** What the provider says about the installation, such as a Linear workspace's name. */
    settings: jsonb("settings"),
    /** The installation's own credentials as JSON, encrypted with `encryptJson`, such as Linear's OAuth tokens. */
    secrets: text("secrets"),
    /** Why the installation stopped working, until it is connected again. */
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("installations_app_external_id").on(table.appId, table.externalId),
    unique("installations_organization_name").on(table.organizationId, table.installationName),
    foreignKey({
      name: "installations_app_organization_fk",
      columns: [table.appId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
    }).onDelete("cascade"),
    check("installations_name_format", sql`${table.installationName} ~ '^[a-z][a-z0-9-]*$'`),
  ],
);

/** An app allowed to a factory: the factory receives the app's provider events. */
export const assignments = pgTable(
  "assignments",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    factoryId: uuid("factory_id")
      .notNull()
      .references(() => factories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.factoryId] }),
    index("assignments_factory_idx").on(table.factoryId),
  ],
);

/** One provider event as received, stored once however many factories get it. */
export const providerEvents = pgTable(
  "provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The app it came through; `null` once that app is removed. */
    appId: uuid("app_id").references(() => apps.id, { onDelete: "set null" }),
    /** The installation it came through; `null` once that installation is removed. */
    installationId: uuid("installation_id").references(() => installations.id, {
      onDelete: "set null",
    }),
    provider: text("provider").$type<Provider>().notNull(),
    name: text("name").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    payload: jsonb("payload").notNull(),
    /** The provider's own id for the event, where it may send one event twice, such as Slack's `event_id`. */
    dedupeKey: text("dedupe_key"),
  },
  (table) => [
    unique("provider_events_app_dedupe_key").on(table.appId, table.dedupeKey),
    index("provider_events_organization_received_idx").on(table.organizationId, table.receivedAt),
  ],
);

/** Every factory's messages, ordered by one sequence across all factories. */
export const factoryMessages = pgTable(
  "factory_messages",
  {
    position: bigint("position", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    factoryId: uuid("factory_id")
      .notNull()
      .references(() => factories.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MessageKind>().notNull(),
    providerEventId: uuid("provider_event_id").references(() => providerEvents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_messages_factory_position_idx").on(table.factoryId, table.position),
    index("factory_messages_provider_event_idx").on(table.providerEventId),
    index("factory_messages_created_at_idx").on(table.createdAt),
  ],
);
