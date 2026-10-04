import { fileURLToPath } from "node:url";
import { createRequestHandler } from "@react-router/express";
import express, { type RequestHandler } from "express";
import type { ServerBuild } from "react-router";
import type { HubAuth } from "./auth.ts";
import type { HubConfig } from "./config.ts";
import type { HubDatabase } from "./db/database.ts";
import type { MessageWaiters } from "./messages.ts";
import { packageRoot as root } from "./package-root.ts";

declare module "react-router" {
  interface AppLoadContext {
    config: HubConfig;
    db: HubDatabase;
    auth: HubAuth;
    waiters: MessageWaiters;
  }
}

/** The React Router app in `app/`, mounted after the hub's own routes. */
export interface WebApp {
  handlers: RequestHandler[];
  close(): Promise<void>;
}

/** The built app from `build/`, or with `dev` the app served from source through Vite. */
export async function createWebApp(
  context: { config: HubConfig; db: HubDatabase; auth: HubAuth; waiters: MessageWaiters },
  dev: boolean,
): Promise<WebApp> {
  const getLoadContext = () => context;
  if (dev) {
    const vite = await import("vite");
    const server = await vite.createServer({
      root: fileURLToPath(root),
      server: { middlewareMode: true },
    });
    const build = () =>
      server.ssrLoadModule("virtual:react-router/server-build") as Promise<ServerBuild>;
    return {
      handlers: [server.middlewares, createRequestHandler({ build, getLoadContext })],
      close: () => server.close(),
    };
  }

  const client = fileURLToPath(new URL("build/client/", root));
  const build: ServerBuild = await import(new URL("build/server/index.js", root).href);
  return {
    handlers: [
      express.static(`${client}assets`, { immutable: true, maxAge: "1y" }),
      express.static(client, { maxAge: "1h" }),
      createRequestHandler({ build, getLoadContext }),
    ],
    close: async () => {},
  };
}
