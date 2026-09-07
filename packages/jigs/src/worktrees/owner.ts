import { getRun } from "workflow/api";
import { TERMINAL_RUN_STATUSES } from "../run-status.ts";

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
