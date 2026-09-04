import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The SDK's observability UI, hosted by the service that writes the World it
// reads. Run standalone it opens that World itself, which also starts a queue
// worker — one that delivers to whatever port the process happens to be
// listening on, where there is no workflow route. In here the World is the
// process-cached instance the runtime made, so the UI shares the service's own
// queue and steals nothing.
//
// The documented defineNitroPlugin subpath doesn't exist at nitro
// 3.0.260610-beta; a plain default export works.
export default async function startDashboard() {
  const port = Number(process.env.JIGS_DASHBOARD_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    console.log("[service] dashboard skipped: JIGS_DASHBOARD_PORT unset");
    return;
  }
  // Nitro does not await its plugins, so the World may not be cached yet. The
  // UI carries its own copy of the resolver and reads the same process-global
  // cache; touching it through the runtime first is what makes the SDK's
  // resolution the one that wins.
  const { getWorld } = await import("workflow/runtime");
  getWorld();
  const { startServer } = await import(dashboardEntry());
  await startServer(port);
  console.log(`[service] dashboard: http://localhost:${port}`);
}

// Resolved from the factory root at run time rather than imported by name:
// @workflow/web loads its compiled UI from a `build/` directory beside its own
// file, so a bundled copy looks for one that is not there. The factory's cwd
// is the same assumption the SDK's own World loader makes.
function dashboardEntry(): string {
  const require = createRequire(path.join(process.cwd(), "index.js"));
  return pathToFileURL(require.resolve("@workflow/web/server")).href;
}
