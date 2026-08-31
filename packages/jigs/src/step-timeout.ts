// The optional cap on how long a single step may run. There is no jigs policy
// here to express — the number exists only because the runtime imposes a
// ceiling it does not expose (AGE-360): @workflow/world-postgres 4.3.4 runs
// every step by POSTing the step route and awaiting the response with a bare
// `fetch` (dist/queue.js:223), so node's undici default `headersTimeout` of
// 300s aborts any step past five minutes and graphile-worker redelivers the
// job — a *second* agent against the same worktree while the first is still
// working. Nothing else in workflow@4.8.4 caps a step's duration.
//
// The service's answer is a dispatcher scoped to its own origin (AGE-364), so
// the step self-invocation waits as long as the step takes and every other
// outbound request keeps undici's defaults. Unset is therefore the default and
// means no cap at all — @workflow/world-local's queue does exactly this
// ("headersTimeout: 0 allows long-running steps"). A factory that wants a step
// to fail rather than hang sets the knob.

export const STEP_TIMEOUT_ENV = "JIGS_STEP_TIMEOUT_MINUTES";

// graphile-worker's own job expiry. With no cap of our own it is the last
// thing that can redeliver a step job, so it is the window a takeover guard
// has to outlast.
export const WORKER_JOB_EXPIRY_MS = 4 * 60 * 60_000;

// Lenient on purpose: jigs.yml is validated at the CLI, and a malformed value
// in the service's environment must not stop the service from booting — it
// reads as no cap, which is also the default.
export function stepTimeoutMinutes(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[STEP_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return null;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

export function stepTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const minutes = stepTimeoutMinutes(env);
  return minutes === null ? null : minutes * 60_000;
}
