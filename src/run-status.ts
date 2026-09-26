// Its own module because both halves read it: the CLI's restart guard would
// otherwise import the run listing, and the world with it, into dist/cli.js.
// A parked run reads `running`, so non-terminal covers live and parked runs alike.
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);
