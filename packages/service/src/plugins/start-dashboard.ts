import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  await startServer(port);
  console.log(`[service] dashboard: http://localhost:${port}`);
}

// Resolved at run time, never imported by name: @workflow/web loads its UI
// from a `build/` beside its own file, which a bundled copy cannot find.
function dashboardEntry(): string {
  const require = createRequire(path.join(process.cwd(), "index.js"));
  return pathToFileURL(require.resolve("@workflow/web/server")).href;
}
