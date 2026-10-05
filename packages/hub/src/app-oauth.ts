import { randomBytes } from "node:crypto";
import type { Provider } from "@jigs-ai/hub-protocol";
import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import type { App } from "./apps.ts";
import type { HubDatabase } from "./db/database.ts";
import { apps } from "./db/schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The provider's app with this id, or `null`; any string may come from a URL. */
export async function findApp(
  db: HubDatabase,
  provider: Provider,
  appId: string,
): Promise<App | null> {
  if (!UUID.test(appId)) return null;
  return (
    (await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.provider, provider)),
    })) ?? null
  );
}

const readCookie = (request: Request, name: string) => {
  for (const part of (request.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
};

/**
 * What an app's admin-started OAuth flow needs around the provider's own
 * steps: the app the admin may act on, and a state checked against an
 * HttpOnly cookie scoped to the app's callback.
 */
export function appOAuth(options: {
  db: HubDatabase;
  provider: Provider;
  /** The provider's name in messages, such as `Linear`. */
  label: string;
  publicUrl: URL;
  callbackPath: (appId: string) => string;
  /** The Organization the request's signed-in user is an admin of, or `null`. */
  adminOrganization: (request: Request) => Promise<string | null>;
}) {
  const { db, provider, label, publicUrl, callbackPath, adminOrganization } = options;
  const cookie = `hub_${provider}_state`;
  const cookieOptions = (app: App) => ({
    httpOnly: true,
    secure: publicUrl.protocol === "https:",
    // Lax still sends it on the provider's top-level redirect back.
    sameSite: "lax" as const,
    path: callbackPath(app.id),
  });

  return {
    /** The full URL the provider returns to. */
    callbackUrl: (app: App) => `${publicUrl.origin}${callbackPath(app.id)}`,

    /** The app named by `:appId` when the signed-in user administers it; otherwise answers 404 and returns `null`. */
    async adminsApp(request: Request, response: Response): Promise<App | null> {
      const app = await findApp(db, provider, String(request.params.appId));
      if (app && (await adminOrganization(request)) === app.organizationId) return app;
      response.status(404).type("text").send(`No ${label} app of yours on this hub has that id.`);
      return null;
    },

    /** A new state, remembered in the admin's cookie for ten minutes. */
    startState(response: Response, app: App): string {
      const state = randomBytes(32).toString("base64url");
      response.cookie(cookie, state, { ...cookieOptions(app), maxAge: 10 * 60 * 1000 });
      return state;
    },

    /**
     * Whether the callback's state is the one this admin started with, and
     * the provider reported no error; otherwise answers 400. Clears the cookie
     * either way, so a state is used once.
     */
    checkCallback(request: Request, response: Response, app: App): boolean {
      const expected = readCookie(request, cookie);
      response.clearCookie(cookie, cookieOptions(app));
      if (!expected || String(request.query.state ?? "") !== expected) {
        response
          .status(400)
          .type("text")
          .send(`This answer from ${label} is not for a request you started. Start again.`);
        return false;
      }
      if (request.query.error) {
        response
          .status(400)
          .type("text")
          .send(
            `${label} did not finish: ${request.query.error_description ?? request.query.error}`,
          );
        return false;
      }
      return true;
    },
  };
}
