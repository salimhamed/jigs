/**
 * Host a factory: its HTTP routes, and the long-running work that starts and settles its runs.
 *
 * @packageDocumentation
 */

import { seedFactoryContext } from "../config/factory-context.ts";
import type { Factory, FactoryDefinition } from "../workflow/factory.ts";
import { parseFactoryConfig } from "../workflow/factory-schema.ts";
import { startAutomaticRelease } from "./automatic-release.ts";
import { startWorld } from "./boot.ts";
import { startDashboard } from "./dashboard.ts";
import { startTriggers } from "./event-triggers/runner.ts";
import { startSchedules } from "./schedules.ts";

export { type AppDeps, createApp } from "./app.ts";
/** @internal */
export { automaticReleaseAction, reconcileAutomaticRelease } from "./automatic-release.ts";

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
  startSchedules(factory);
  startTriggers(factory);
  startAutomaticRelease(factory);
}
