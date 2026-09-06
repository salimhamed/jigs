// How far the boot has got, beside the liveness /health already reports. The
// start-world plugin advances it; the route reads it; `jigs service start`
// waits on it. Module-level because the plugin and the route meet nowhere
// else — nitro hands neither a reference to the other.

export const READY_PHASE = "ready";

let phase = "starting";

export function setBootPhase(next: string): void {
  phase = next;
}

export function bootPhase(): string {
  return phase;
}

export function isReady(): boolean {
  return phase === READY_PHASE;
}
