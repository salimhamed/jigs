import express, { type Express } from "express";
import type { WebApp } from "./web.ts";

/** The hub's HTTP app. `/api/*` and `/webhooks/*` routes go here, ahead of the web app. */
export function createHubApp(web: WebApp): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.use(web.handlers);
  return app;
}
