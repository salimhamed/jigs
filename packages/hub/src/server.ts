import { toNodeHandler } from "better-auth/node";
import express, { type Express, type Router } from "express";
import type { HubAuth } from "./auth.ts";
import type { Shutdown } from "./shutdown.ts";
import type { WebApp } from "./web.ts";

/** The hub's HTTP app. `/api/*` and `/webhooks/*` routes go here, ahead of the web app. */
export function createHubApp(
  auth: HubAuth,
  routers: Router[],
  web: WebApp,
  shutdown: Shutdown,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(shutdown.gate);
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.use(authApp(auth));
  for (const router of routers) app.use(router);
  app.use(web.handlers);
  return app;
}

// Better Auth rate-limits sign-in by the client IP it reads from X-Forwarded-For. Trust that header
// only from a proxy on this machine or a private network, such as Tailscale Funnel or a load
// balancer, so a client reaching the hub directly cannot pick its own bucket.
function authApp(auth: HubAuth): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback, uniquelocal");
  const handler = toNodeHandler(auth);
  app.all("/api/auth/*splat", (request, response) => {
    // The web app calls the Organization endpoints server-side, behind the hub's own role checks.
    // Over HTTP they would hand any member what only admins may see, such as invite links. Check
    // the path as Better Auth will route it, with dot segments resolved.
    const { pathname } = new URL(request.url, "http://hub");
    if (pathname.toLowerCase().startsWith("/api/auth/organization/")) {
      response.sendStatus(404);
      return;
    }
    if (request.ip) request.headers["x-forwarded-for"] = request.ip;
    return handler(request, response);
  });
  return app;
}
