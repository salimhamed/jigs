import { toNodeHandler } from "better-auth/node";
import express, { type Express, type Router } from "express";
import type { HubAuth } from "./auth.ts";
import type { WebApp } from "./web.ts";

/** The hub's HTTP app. `/api/*` and `/webhooks/*` routes go here, ahead of the web app. */
export function createHubApp(auth: HubAuth, routers: Router[], web: WebApp): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.all("/api/auth/*splat", toNodeHandler(auth));
  for (const router of routers) app.use(router);
  app.use(web.handlers);
  return app;
}
