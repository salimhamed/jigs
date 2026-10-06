// The service's one running trigger engine, and the timer that drains it.

import type { Factory } from "../../workflow/factory.ts";
import type { Provider } from "../../workflow/providers.ts";
import { whenReady } from "../readiness.ts";
import { onShutdown } from "../shutdown.ts";
import { createTriggerEngine, type TriggerDeps, type TriggerEngine } from "./engine.ts";
import type { PushedEvent } from "./sources.ts";

// How soon an occurrence waiting on the cap notices a run finishing. While
// nothing waits, each check is one read of the pending rows.
const DRAIN_INTERVAL_MS = 30_000;

/** Injectable timers and readiness, on top of the engine's own dependencies. */
export interface StartTriggersDeps extends TriggerDeps {
  ready?: () => Promise<void>;
  /** Schedules one call and returns its canceller. */
  setTimer?: (fire: () => void, ms: number) => () => void;
}

let running: TriggerEngine | undefined;

/**
 * Starts the factory's event triggers once the service is ready: leftover
 * pending occurrences first, then whatever pushed events record, until the
 * service shuts down.
 */
export function startTriggers(factory: Factory, deps: StartTriggersDeps = {}): TriggerEngine {
  const engine = createTriggerEngine(factory, deps);
  if (engine.triggers.length === 0) return engine;
  running = engine;
  const log = deps.log ?? console.log;
  const setTimer =
    deps.setTimer ??
    ((fire: () => void, ms: number) => {
      const timer = setTimeout(fire, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  let cancel = () => {};
  let stopped = false;
  // Quiesce, not close: a start still in flight needs the World and the
  // registry pool that the close phase ends.
  onShutdown(
    async () => {
      stopped = true;
      cancel();
      if (running === engine) running = undefined;
      await engine.stop();
    },
    { phase: "quiesce" },
  );

  const drainAgain = () => {
    if (!stopped) cancel = setTimer(() => void engine.drain().then(drainAgain), DRAIN_INTERVAL_MS);
  };

  void (async () => {
    try {
      await (deps.ready ?? whenReady)();
      if (stopped) return;
      // A failed arm's markers are retried by every push, and its settle clock
      // is already set; the drain runs either way.
      await engine.arm().catch((error: unknown) => {
        log(`[trigger] could not enable triggers, retrying on each push: ${String(error)}`);
      });
      for (const { name, provider } of engine.triggers)
        log(`[trigger] ${name} started: takes ${provider} events from the hub`);
      drainAgain();
    } catch (error) {
      log(`[trigger] event triggers not started: ${String(error)}`);
    }
  })();
  return engine;
}

/**
 * Hand a provider's pushed event to the running event triggers watching that
 * provider. It returns once the occurrence is recorded, before any run starts,
 * with the names of the triggers that took it. Rejects when a trigger could not
 * read the event, after the others have taken it.
 */
export async function pushEvent(provider: Provider, event: PushedEvent): Promise<string[]> {
  return running === undefined ? [] : running.push(provider, event);
}
