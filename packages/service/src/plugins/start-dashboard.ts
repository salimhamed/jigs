import type { Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { onShutdown } from "../shutdown";

// Hosted here rather than run standalone: a second process opening this World
// runs a second queue worker, which steals the service's jobs.
export default async function startDashboard() {
  const port = Number(process.env.JIGS_DASHBOARD_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    console.log("[service] dashboard skipped: JIGS_DASHBOARD_PORT unset");
    return;
  }
  // Nitro does not await its plugins, so touching the World through the
  // runtime is what makes the SDK's resolution win the process-global cache.
  const { getWorld } = await import("workflow/runtime");
  getWorld();
  const { startServer } = await import(dashboardEntry());
  const server: Server = await startServer(port);
  onShutdown(() => closeServer(server));
  console.log(`[service] dashboard: http://localhost:${port}`);
}

// `close()` alone waits out keep-alive sockets, and a dashboard tab left open
// holds one — so drop every connection rather than wait on the browser.
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (
        err === undefined ||
        (err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
      ) {
        resolve();
      } else {
        reject(err);
      }
    });
    server.closeAllConnections();
  });
}

// Resolved at run time, never imported by name: @workflow/web loads its UI
// from a `build/` beside its own file, which a bundled copy cannot find.
function dashboardEntry(): string {
  const require = createRequire(path.join(process.cwd(), "index.js"));
  return pathToFileURL(require.resolve("@workflow/web/server")).href;
}
