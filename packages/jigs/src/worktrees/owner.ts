import { getRun } from "workflow/api";

// The SDK has no `suspended` status — a parked run reads `running` — so
// non-terminal covers live and suspended owners alike (a suspended run
// holds its worktree).
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface OwnerState {
  terminal: boolean;
  status: string;
}

// A run the world no longer knows about is as terminal as one that finished:
// nothing will ever come back for its worktree.
export async function readOwner(runId: string): Promise<OwnerState> {
  const run = getRun(runId);
  if (!(await run.exists)) return { terminal: true, status: "unknown" };
  const status = await run.status;
  return { terminal: TERMINAL_RUN_STATUSES.has(status), status };
}
