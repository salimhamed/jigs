// Its own module because both halves read it: the CLI's restart guard would
// otherwise import the run listing, and the world with it, into dist/cli.js.
// The SDK has no `suspended` status — a parked run reads `running` — so
// non-terminal covers live and suspended runs alike.
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
