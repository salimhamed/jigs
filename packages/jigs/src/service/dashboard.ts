import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { currentFactoryContext } from "../config/factory-context.ts";
import { onShutdown } from "./shutdown.ts";

// Hosted here rather than run standalone: a second process opening this World
// runs a second queue worker, which steals the service's jobs.
/** Start the Workflow dashboard and register its shutdown cleanup. */
export async function startDashboard() {
  const port = Number(currentFactoryContext().env("JIGS_DASHBOARD_PORT"));
  // Nitro does not await its plugins, so touching the World through the
  // runtime is what makes the SDK's resolution win the process-global cache.
  const { getWorld } = await import("workflow/runtime");
  await getWorld();
  const { startServer } = await import(dashboardEntry());
  const server: DashboardServer = await startServer(port);
  // A dashboard tab left open holds a keep-alive socket, so drop every
  // connection rather than wait on the browser.
  onShutdown(() => server.close(true));
  console.log(`[service] dashboard: http://localhost:${port}`);
}

// The srvx server @workflow/web starts. The entry is loaded by path, so its
// types do not reach here.
interface DashboardServer {
  close(closeActiveConnections: boolean): Promise<void>;
}

// Resolved at run time, never imported by name: @workflow/web loads its UI
// from a `build/` beside its own file, which a bundled copy cannot find.
function dashboardEntry(): string {
  const require = createRequire(path.join(process.cwd(), "index.js"));
  return pathToFileURL(require.resolve("@workflow/web/server")).href;
}
