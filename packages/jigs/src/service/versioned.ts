// Run this copy as the factory: either as its only copy, or as a deployment
// version (ADR 0019) that records its boot, keeps its heartbeat, follows the
// current version into the current or the draining role, and relays
// live-turn messages between copies.

import { hostname } from "node:os";
import { currentFactoryContext, type FactoryContext } from "../config/factory-context.ts";
import { hubConnection } from "../providers/hub.ts";
import { type RegistrySql, registrySql } from "../steps/runtime/registry.ts";
import type { Factory } from "../workflow/factory.ts";
import { inactiveTriggerNames } from "./active.ts";
import { startAutomaticRelease } from "./automatic-release.ts";
import { startDashboard } from "./dashboard.ts";
import { drainPass } from "./deployments/drain.ts";
import {
  currentDeployment,
  DEPLOYMENTS_CHANNEL,
  HEARTBEAT_MS,
  recordDeploymentBoot,
  recordDeploymentStop,
  touchDeployment,
  wasEverCurrent,
} from "./deployments/store.ts";
import { pushEvent, startTriggers, withdrawInactive } from "./event-triggers/runner.ts";
import { startHubClient } from "./hub-client.ts";
import { startLiveTurnRelay } from "./live-turn-relay.ts";
import { whenReady } from "./readiness.ts";
import { registryListener } from "./registry-listener.ts";
import { type CurrentRoleParts, startRoleController } from "./role.ts";
import {
  deploymentBasePrefix,
  deploymentVersion,
  type ServiceRole,
  setServiceRole,
} from "./role-state.ts";
import { cancelRun } from "./runs.ts";
import { startSchedules } from "./schedules.ts";
import { beginShutdown, onShutdown } from "./shutdown.ts";

const setTimer = (fire: () => void, ms: number) => {
  const timer = setTimeout(fire, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Be the factory for as long as this copy runs: the copy has no deployment version, so no other
 * copy shares its work. `live` is the factory with only its active triggers and schedules.
 */
export async function runAsOnlyCopy(factory: Factory, live: Factory): Promise<void> {
  // Started before the World is ready, as each part waits on readiness itself,
  // so the dashboard is up while the boot gates run.
  const work = startFactoryWork(factory, live);
  onShutdown(() => work.stop(), { phase: "quiesce" });
  void startDashboard().then((dashboard) => onShutdown(() => dashboard.close()));
  await whenReady();
  const client = startHub(currentFactoryContext());
  onShutdown(async () => client?.stop(), { phase: "quiesce" });
}

/**
 * Once the World is ready, take this copy's role and keep it. `live` is the factory with only
 * its active triggers and schedules.
 */
export async function runAsVersion(factory: Factory, live: Factory): Promise<void> {
  await whenReady();
  const ctx = currentFactoryContext();
  const version = deploymentVersion();
  const jobPrefix = deploymentBasePrefix();
  if (version === undefined || jobPrefix === undefined)
    throw new Error("the deployment version was not pinned before boot");
  const db = registrySql();
  const { slug } = ctx;
  const heartbeat = await startHeartbeat(db, slug, version);
  onShutdown(() => heartbeat.stop(), { phase: "quiesce" });

  const listener = registryListener();
  onShutdown(() => listener.close());
  const relay = startLiveTurnRelay({ listener, db: registrySql, factory: slug });
  onShutdown(() => relay.stop(), { phase: "quiesce" });

  const controller = startRoleController({
    version,
    currentVersion: () => currentDeployment(db, slug),
    wasEverCurrent: () => wasEverCurrent(db, slug, version),
    subscribe: (fire) =>
      listener.subscribe(DEPLOYMENTS_CHANNEL, (payload) => {
        if (payload === slug) fire();
      }),
    startCurrentRole: () => startCurrentRole(factory, live, ctx),
    drain: () =>
      drainPass({
        db,
        factory: slug,
        owner: { version, jobPrefix },
        maxDrainDays: ctx.config.deployments.maxDrainDays,
        cancel: cancelRun,
        log: console.log,
      }),
    onRole: (role, current) => setServiceRole(role, current),
    exit: (reason) => beginShutdown(reason),
    setTimer,
    log: console.log,
  });
  onShutdown(() => controller.stop(), { phase: "quiesce" });
}

// Records this copy's boot and refreshes its heartbeat until it stops, when it records that the
// copy no longer runs: a version that drained and exited is not offered as a rollback target.
async function startHeartbeat(
  db: RegistrySql,
  factory: string,
  version: string,
): Promise<{ stop(): Promise<void> }> {
  const thisProcess = { pid: process.pid, host: hostname() };
  await recordDeploymentBoot(db, factory, version, thisProcess);
  let lastTouch: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    lastTouch = touchDeployment(db, factory, version, thisProcess).catch((error: unknown) => {
      console.error(`[service] heartbeat failed: ${String(error)}`);
    });
  }, HEARTBEAT_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      // A touch still in flight would claim the row again after the stop.
      await lastTouch;
      await recordDeploymentStop(db, factory, version, thisProcess);
    },
  };
}

// Everything only the factory does: hearing the hub, firing triggers and
// schedules, releasing, and answering on the dashboard. Started on becoming
// current, stopped on ceasing to be.
async function startCurrentRole(
  factory: Factory,
  live: Factory,
  ctx: FactoryContext,
): Promise<CurrentRoleParts> {
  const work = startFactoryWork(factory, live);
  const dashboard = await startDashboard();
  const client = startHub(ctx);
  return {
    async stop() {
      // The hub first, so no event is admitted into triggers that are stopping.
      await client?.stop();
      await work.stop();
      await dashboard.close();
    },
  };
}

function startFactoryWork(factory: Factory, live: Factory): { stop(): Promise<void> } {
  void withdrawInactive(inactiveTriggerNames(factory));
  const schedules = startSchedules(live);
  const triggers = startTriggers(live);
  const release = startAutomaticRelease(factory);
  return {
    async stop() {
      await triggers.stop();
      for (const job of schedules) job.stop();
      await release.stop();
    },
  };
}

// The hub keeps what it holds until it is confirmed, so whatever arrived while
// the copy was not the factory comes first.
function startHub(ctx: FactoryContext): { stop(): Promise<void> } | undefined {
  const hub = hubConnection(ctx);
  if (hub === undefined) return undefined;
  return startHubClient({ ...hub, route: { context: ctx, push: pushEvent } });
}

export type { ServiceRole };
