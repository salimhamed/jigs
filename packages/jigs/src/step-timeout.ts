// How long a single step may run. This is not a jigs policy choice — it is a
// ceiling the runtime imposes and does not expose (AGE-360):
// @workflow/world-postgres 4.3.4 runs every step by POSTing the step route and
// awaiting the response with a bare `fetch` (dist/queue.js:223), so node's
// undici default `headersTimeout` of 300s aborts any step past five minutes
// and graphile-worker redelivers the job — a *second* agent against the same
// worktree while the first is still working. Nothing else in workflow@4.8.4
// caps a step's duration, and world-postgres takes no config for this
// (`createWorld()` is called with no arguments), so the service raises the
// ceiling itself by installing an undici dispatcher at startup.
//
// Agent steps are the reason for the size: a builder turn is minutes to tens
// of minutes, and 45 sits well under graphile-worker's own 4h job expiry.

export const STEP_TIMEOUT_ENV = "JIGS_STEP_TIMEOUT_MINUTES";
export const DEFAULT_STEP_TIMEOUT_MINUTES = 45;

// Lenient on purpose: jigs.yml is validated at the CLI, and a malformed value
// in the service's environment must not stop the service from booting.
export function stepTimeoutMinutes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[STEP_TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_STEP_TIMEOUT_MINUTES;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_STEP_TIMEOUT_MINUTES;
}

export function stepTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return stepTimeoutMinutes(env) * 60_000;
}
