import { STEP_TIMEOUT_ENV, stepTimeoutMs } from "jigs";

// Raises the ceiling on how long one step may run. The ceiling is not ours:
// @workflow/world-postgres 4.3.4 runs every step by POSTing the step route and
// awaiting the response with a bare `fetch` and no dispatcher
// (dist/queue.js:223), so node's undici default `headersTimeout` of 300s
// aborts the request five minutes in, graphile-worker fails and redelivers the
// job (maxAttempts 3, exp(attempts)-second backoff), and a second agent starts
// against a worktree the first is still working in — the AGE-360 duplicates,
// whose step_started events landed 5:04 and 5:09 apart. world-postgres takes
// no config for this and `createWorld()` is called with no arguments, so the
// only reachable knob is the dispatcher node's global fetch uses.
//
// @workflow/world-local already does exactly this (its queue builds an Agent
// with `headersTimeout: 0`); world-postgres was ported without it, which is
// why the ADR 0008 prototype's 600-second step passed.
//
// Finite rather than 0: the global dispatcher governs every outbound fetch in
// this process (GitHub, Linear, the agent providers), and a wedged request
// should still eventually fail. See jigs' step-timeout.ts for the value.

export type DispatcherInstall = (timeoutMs: number) => Promise<void> | void;

const undiciGlobalDispatcher: DispatcherInstall = async (timeoutMs) => {
  const { Agent, setGlobalDispatcher } = await import("undici");
  // Userland undici and node's internal copy share
  // Symbol.for('undici.globalDispatcher.1'), and node installs its own only
  // lazily — so this is what `fetch` picks up.
  setGlobalDispatcher(
    new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
  );
};

export async function raiseStepCeiling(
  env: NodeJS.ProcessEnv = process.env,
  install: DispatcherInstall = undiciGlobalDispatcher,
): Promise<number> {
  const timeoutMs = stepTimeoutMs(env);
  await install(timeoutMs);
  return timeoutMs;
}

export function describeStepCeiling(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const minutes = stepTimeoutMs(env) / 60_000;
  const source =
    env[STEP_TIMEOUT_ENV] === undefined ? "default" : STEP_TIMEOUT_ENV;
  return `${minutes}m (${source})`;
}
