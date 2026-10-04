// The service's one running trigger engine, and the timers that drive it.

import { currentFactoryContext } from "../../config/factory-context.ts";
import type { Factory } from "../../workflow/factory.ts";
import type { Provider } from "../../workflow/providers.ts";
import { nudgeDelay } from "../nudge.ts";
import { whenReady } from "../readiness.ts";
import { onShutdown } from "../shutdown.ts";
import { createTriggerEngine, type TriggerDeps, type TriggerEngine } from "./engine.ts";

// How soon an occurrence waiting on the cap notices a run finishing. While
// nothing waits, each check is one read of the pending rows.
const DRAIN_INTERVAL_MS = 30_000;

/** Injectable timers, readiness and intervals, on top of the engine's own dependencies. */
export interface StartTriggersDeps extends TriggerDeps {
  intervalSeconds?: () => Promise<Record<Provider, number>>;
  ready?: () => Promise<void>;
  random?: () => number;
  /** Schedules one call and returns its canceller. */
  setTimer?: (fire: () => void, ms: number) => () => void;
}

let running: TriggerEngine | undefined;

/**
 * Starts the factory's event triggers once the service is ready: leftover
 * pending occurrences first, then a poll per trigger on its provider's
 * interval, until the service shuts down.
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
  const cancels = new Map<string, () => void>();
  let stopped = false;
  // Quiesce, not close: a start still in flight needs the World and the
  // registry pool that the close phase ends.
  onShutdown(
    async () => {
      stopped = true;
      for (const cancel of cancels.values()) cancel();
      if (running === engine) running = undefined;
      await engine.stop();
    },
    { phase: "quiesce" },
  );

  const repeat = (key: string, delay: () => number, once: () => Promise<void>) => {
    const next = () => {
      if (!stopped)
        cancels.set(
          key,
          setTimer(() => void once().then(next), delay()),
        );
    };
    return next;
  };

  void (async () => {
    try {
      await (deps.ready ?? whenReady)();
      const intervals = await (deps.intervalSeconds ?? configuredIntervals)();
      if (stopped) return;
      // A failed arm's markers are retried by every poll, and its settle clock
      // is already set; the timers run either way.
      await engine.arm().catch((error: unknown) => {
        log(`[trigger] could not enable triggers, retrying on each poll: ${String(error)}`);
      });
      for (const { name, provider } of engine.triggers) {
        log(`[trigger] ${name} started: polls ${provider} every ${intervals[provider]}s`);
        const poll = () => engine.poll(name);
        // At once too: an occurrence from while the service was down is only
        // found by a poll.
        void poll().then(
          repeat(`poll:${name}`, () => nudgeDelay(intervals[provider], deps.random), poll),
        );
      }
      repeat("drain", () => DRAIN_INTERVAL_MS, engine.drain)();
    } catch (error) {
      log(`[trigger] event triggers not started: ${String(error)}`);
    }
  })();
  return engine;
}

/**
 * Hand a provider's pushed event to the running event triggers watching that
 * provider. It returns once the occurrence is recorded, before any run starts,
 * with the names of the triggers that took it.
 */
export async function pushEvent(provider: Provider, event: unknown): Promise<string[]> {
  return running === undefined ? [] : running.push(provider, event);
}

async function configuredIntervals(): Promise<Record<Provider, number>> {
  // No trigger source reads GitHub, which the service never polls.
  return currentFactoryContext().config.service.pollIntervalSeconds as Record<Provider, number>;
}
