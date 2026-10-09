/**
 * Host a factory: its HTTP routes, and the long-running work that starts and settles its runs.
 *
 * @packageDocumentation
 */

import { resolveService } from "../config/factory-config.ts";
import { currentFactoryContext, seedFactoryContext } from "../config/factory-context.ts";
import { JigsError } from "../errors.ts";
import type { Factory, FactoryDefinition } from "../workflow/factory.ts";
import { parseFactoryConfig } from "../workflow/factory-schema.ts";
import { activeFactory } from "./active.ts";
import { startAutomaticRelease } from "./automatic-release.ts";
import { startWorld } from "./boot.ts";
import { startDashboard } from "./dashboard.ts";
import { startTriggers, withdrawInactive } from "./event-triggers/runner.ts";
import { startSchedules } from "./schedules.ts";

export { type AppDeps, createApp } from "./app.ts";
/** @internal */
export { automaticReleaseAction, reconcileAutomaticRelease } from "./automatic-release.ts";

/**
 * Point Nitro and the World at `JIGS_SERVICE_PORT`, or exit naming a missing port variable. Call
 * it at the top level of the service's Nitro plugin, after the factory configuration has loaded
 * its environment and before Nitro reads `PORT` to listen.
 */
export function listenOnServicePort(): void {
  try {
    const { port, serviceUrl } = resolveService(currentFactoryContext());
    // biome-ignore lint/style/noProcessEnv: Nitro's own listen port, derived from the factory's
    process.env.PORT = String(port);
    // Pins every queue worker, the dashboard's included, to this service's own workflow routes.
    // Left unset the World guesses a port the process listens on, and a job delivered to the
    // dashboard's port dies after three 404s.
    // biome-ignore lint/style/noProcessEnv: the SDK's own setting, derived from the factory's
    process.env.WORKFLOW_LOCAL_BASE_URL = serviceUrl;
  } catch (err) {
    if (!(err instanceof JigsError)) throw err;
    console.error(`[service] ${err.message}`);
    process.exit(1);
  }
}

/**
 * Start everything the service runs beside its routes: the World behind its startup checks, the
 * dashboard, schedules, event triggers and automatic release. Call it once, from the service's
 * Nitro plugin, with the factory configuration the service was built from.
 */
export function startService(factory: Factory, config: FactoryDefinition): void {
  seedFactoryContext(parseFactoryConfig(config));
  // Started in this order and never awaited, the way Nitro runs separate
  // plugins: each later part waits on the World's readiness itself.
  void startWorld();
  void startDashboard();
  const live = activeFactory(factory);
  for (const name of Object.keys(factory.schedules ?? {}))
    if (live.schedules?.[name] === undefined) console.log(`[schedule] ${name} inactive`);
  const inactive = Object.keys(factory.triggers ?? {}).filter(
    (name) => live.triggers?.[name] === undefined,
  );
  for (const name of inactive) console.log(`[trigger] ${name} inactive`);
  startSchedules(live);
  startTriggers(live);
  void withdrawInactive(inactive);
  startAutomaticRelease(factory);
}
