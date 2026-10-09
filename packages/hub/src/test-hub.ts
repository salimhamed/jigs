import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import express, { type Request, type Router } from "express";
import { afterAll, beforeAll } from "vitest";
import { connectDatabase, migrateDatabase } from "./db/database.ts";
import * as schema from "./db/schema.ts";
import { testDatabase } from "./db/test-database.ts";
import { addFactory } from "./factories.ts";
import { createFactoryApi } from "./factory-api.ts";
import { LinearTokens } from "./linear.ts";
import { MessageWaiters, readMessages } from "./messages.ts";

/** The Organization a test hub's factories and apps belong to unless a test names `"other"`. */
export const organizationId = "acme";

/** Message waiters that count each factory's held long polls, so a test can wait for one. */
export class CountingWaiters extends MessageWaiters {
  readonly #held = new Map<string, number>();

  override async wait(factoryId: string, ms: number, signal: AbortSignal): Promise<void> {
    this.#held.set(factoryId, this.held(factoryId) + 1);
    try {
      await super.wait(factoryId, ms, signal);
    } finally {
      this.#held.set(factoryId, this.held(factoryId) - 1);
    }
  }

  held(factoryId: string): number {
    return this.#held.get(factoryId) ?? 0;
  }
}

/**
 * One test file's hub: a migrated database holding the Organizations `acme`
 * and `other`, the servers the file listens on, and helpers. Call it once at
 * the file's top level; it tears everything down after the file's tests.
 */
export function setUpTestHub() {
  const database = testDatabase();
  const db = connectDatabase(database.url);
  const encryptionKey = randomBytes(32);
  const waiters = new CountingWaiters();
  const servers: Server[] = [];
  let hubUrl = "";
  let factories = 0;

  beforeAll(async () => {
    await database.create();
    await migrateDatabase(db);
    await db.insert(schema.organization).values([
      { id: organizationId, name: "Acme", slug: "acme", createdAt: new Date() },
      { id: "other", name: "Other", slug: "other", createdAt: new Date() },
    ]);
  });

  afterAll(async () => {
    waiters.close();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    await db.$client.end();
    await database.drop();
  });

  /** Serve an Express app, such as a fake provider, on a free port; returns its URL. */
  const listen = async (app: express.Express) => {
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  return {
    db,
    encryptionKey,
    waiters,
    listen,

    /** Serve a provider's routes, if any, ahead of the factory API; returns the hub's URL. */
    async serveHub(
      options: {
        routes?: Router;
        linearTokens?: LinearTokens;
        apiUrls?: { github?: string; pagerduty?: string };
      } = {},
    ) {
      const app = express();
      if (options.routes) app.use(options.routes);
      hubUrl = await listen(
        app.use(
          createFactoryApi({
            db,
            waiters,
            encryptionKey,
            linearTokens: options.linearTokens ?? new LinearTokens({ db, encryptionKey }),
            apiUrls: options.apiUrls,
          }),
        ),
      );
      return hubUrl;
    },

    async newFactory(organization = organizationId) {
      factories += 1;
      return addFactory(db, organization, `factory ${factories}`, null);
    },

    /** The names of a factory's unconfirmed messages: an event's name, or the message's kind. */
    async eventNames(factoryId: string) {
      return (await readMessages(db, factoryId)).map((message) =>
        message.kind === "event" ? message.event.name : message.kind,
      );
    },

    /** Name an app's installation with this external id, as an admin does on its page. */
    async nameInstallation(appId: string, externalId: string, installationName: string) {
      await db
        .update(schema.installations)
        .set({ installationName })
        .where(
          and(
            eq(schema.installations.appId, appId),
            eq(schema.installations.externalId, externalId),
          ),
        );
    },

    /** POST a provider token request to the hub as the factory with `token`. */
    async requestToken(path: string, token: string, body: unknown = {}) {
      const response = await fetch(`${hubUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": "jigs/1.2.3",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

/** Stands in for the session: the `x-admin-of` header names the Organization the caller administers. */
export const adminFromHeader = async (request: Request) => request.get("x-admin-of") ?? null;

const asAdminOf = (admin: string | null): Record<string, string> =>
  admin ? { "x-admin-of": admin } : {};

/** Start an admin's OAuth flow at `url`, as an admin of `admin`. */
export const startOAuth = (url: string, admin: string | null) =>
  fetch(url, { redirect: "manual", headers: asAdminOf(admin) });

/** The state cookie a started flow set, as a `cookie` header. */
export const stateCookie = (started: Response) =>
  (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** The provider's authorize URL a started flow redirects to. */
export const authorizeUrl = (started: Response) => new URL(started.headers.get("location") ?? "");

/** Come back to the callback at `url`, as the provider does, with the admin's cookie. */
export async function finishOAuth(
  url: string,
  query: Record<string, string>,
  cookie: string,
  admin: string | null,
) {
  const response = await fetch(`${url}?${new URLSearchParams(query)}`, {
    redirect: "manual",
    headers: { cookie, ...asAdminOf(admin) },
  });
  return { status: response.status, location: response.headers.get("location") };
}
