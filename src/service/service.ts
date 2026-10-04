/**
 * Host a factory: its HTTP routes, and the long-running work that starts and settles its runs.
 *
 * @packageDocumentation
 */

import type { Factory } from "../workflow/factory.ts";
import { startAutomaticRelease } from "./automatic-release.ts";
import { startWorld } from "./boot.ts";
import { startDashboard } from "./dashboard.ts";
import { startSchedules } from "./schedules.ts";
import { startTriggers } from "./triggers.ts";

export { type AppDeps, createApp } from "./app.ts";
/** @internal */
export { automaticReleaseAction, reconcileAutomaticRelease } from "./automatic-release.ts";

/**
 * Start everything the service runs beside its routes: the World behind its startup checks, the
 * dashboard, schedules, event triggers and automatic release. Call it once, from the service's
 * Nitro plugin.
 */
export function startService(factory: Factory): void {
  // Started in this order and never awaited, the way Nitro runs separate
  // plugins: each later part waits on the World's readiness itself.
  void startWorld();
  void startDashboard();
  startSchedules(factory);
  startTriggers(factory);
  startAutomaticRelease(factory);
}
