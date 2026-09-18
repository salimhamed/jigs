import { getRun } from "workflow/api";
import type { Factory } from "../../blocks/factory.ts";
import type { ReleasePolicy } from "../../blocks/runtime/release.ts";
import { readFactoryConfig } from "../../config/factory-config.ts";
import { factoryRoot } from "../../config/factory-root.ts";
import { TERMINAL_RUN_STATUSES } from "../../run-status.ts";
import { effectiveReleasePolicy, workflowReleasePolicy } from "../runtime/release-policy.ts";

export interface OwnerState {
  terminal: boolean;
  status: string;
  release?: ReleasePolicy;
}

// A run the world no longer knows about is as terminal as one that finished:
// nothing will ever come back for its worktree.
export async function readOwner(runId: string, factory?: Factory): Promise<OwnerState> {
  const run = getRun(runId);
  if (!(await run.exists)) return { terminal: true, status: "unknown" };
  const status = await run.status;
  const release =
    factory === undefined
      ? undefined
      : effectiveReleasePolicy(
          workflowReleasePolicy(factory, await run.workflowName),
          readFactoryConfig(factoryRoot()).release,
        );
  return {
    terminal: TERMINAL_RUN_STATUSES.has(status),
    status,
    ...(release === undefined ? {} : { release }),
  };
}
