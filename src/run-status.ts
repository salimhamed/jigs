// Its own module because both halves read it: the CLI's restart guard would
// otherwise import the run listing, and the world with it, into dist/cli.js.
// The SDK has no `suspended` status — a parked run reads `running` — so
// non-terminal covers live and suspended runs alike.
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// A run that hit its round limit and one that merged are both `completed` to
// the SDK: only the outcome the workflow returned tells them apart. Anything
// but a merge — or a workflow that returned no result status at all — is worth
// an operator's attention, so `jigs ps`, `jigs logs` and `jigs watch` mark it.
const QUIET_OUTCOMES: ReadonlySet<string> = new Set(["merged", "completed"]);

export const outcomeNeedsAttention = (outcome: string | null): boolean =>
  outcome !== null && !QUIET_OUTCOMES.has(outcome);
