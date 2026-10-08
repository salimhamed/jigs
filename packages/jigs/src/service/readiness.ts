// How far the boot has got, beside the liveness /health already reports. The
// service boot advances it; the route reads it; `jigs up`
// waits on it. Module-level because the plugin and the route meet nowhere
// else — nitro hands neither a reference to the other.

export const READY_PHASE = "ready";

let phase = "starting";
const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();

export function setBootPhase(next: string): void {
  phase = next;
  if (next === READY_PHASE) markReady();
}

/** Settles once the boot is ready; never, if it fails, because the service exits. */
export const whenReady = (): Promise<void> => ready;

export function bootPhase(): string {
  return phase;
}

export function isReady(): boolean {
  return phase === READY_PHASE;
}
