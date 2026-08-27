import { rmSync } from "node:fs";
import {
  applyTeardown,
  decideTeardown,
  describeFf,
  fastForwardDefaultBranch,
  isWorktreeDirty,
  type ResolvedBinding,
  removeManagedCodexHome,
  resolveBindings,
} from "jigs";
import type { Sql } from "postgres";
import {
  deleteWorktree,
  listWorktreesForRun,
  setWorktreeState,
} from "./registry";
import { factoryRoot } from "./request";
import { ffByCheckout } from "./sweep";

// The per-run teardown a jig calls on its own completion path. `merged` is
// passed in and never derived: a squash merge leaves the branch tip
// un-ancestored, so isBranchMerged's `merge-base --is-ancestor` answers false
// and the done row would silently degrade to the failed one — GitHub's
// `merged: true` is the only honest evidence.
//
// Deliberately not a filtered `sweepWorktrees`: the sweep's classifier answers
// "is somebody else's leftover reclaimable", and it answers `held` for a run
// still executing its own body. Both paths share the one matrix
// implementation (decideTeardown / applyTeardown), which is what ADR 0007
// requires; the sweep timer stays the net for runs that never reach here.

export interface TeardownRunDeps {
  sql: Sql;
  bindings?: () => ResolvedBinding[];
  fastForward?: typeof fastForwardDefaultBranch;
  removeCodexHome?: (runKey: string) => void;
  log?: (line: string) => void;
}

export async function teardownRun(
  runId: string,
  outcome: { merged: boolean },
  deps: TeardownRunDeps,
): Promise<string[]> {
  const ff = deps.fastForward ?? fastForwardDefaultBranch;
  const removeCodexHome = deps.removeCodexHome ?? removeManagedCodexHome;
  const log = deps.log ?? ((line: string) => console.log(line));
  // A service with no reachable factory config still tears down; only the
  // fast-forward opt-out needs the binding list.
  let bindings: ResolvedBinding[] = [];
  try {
    bindings = (deps.bindings ?? (() => resolveBindings(factoryRoot())))();
  } catch {
    bindings = [];
  }
  const ffEnabled = ffByCheckout(bindings);

  const rows = await listWorktreesForRun(deps.sql, runId);
  const fastForwarded = new Set<string>();
  const removed: string[] = [];
  for (const row of rows) {
    if (
      outcome.merged &&
      row.checkoutRoot !== "" &&
      !fastForwarded.has(row.checkoutRoot)
    ) {
      fastForwarded.add(row.checkoutRoot);
      const result = await ff({
        checkoutRoot: row.checkoutRoot,
        enabled: ffEnabled.get(row.checkoutRoot) ?? true,
      });
      log(`[teardown] ${describeFf(row.checkoutRoot, result)}`);
    }
    const plan = decideTeardown({
      keep: row.keep,
      dirty: await isWorktreeDirty(row.path),
      merged: outcome.merged,
    });
    if (plan.preserve !== null) {
      await setWorktreeState(deps.sql, row.path, plan.preserve);
      log(`[teardown] preserved ${row.path} as ${plan.preserve}`);
      continue;
    }
    if (!plan.removeWorktree) continue;
    await applyTeardown(plan, {
      checkoutRoot: row.checkoutRoot,
      worktreePath: row.path,
      branch: row.branch,
    });
    // git refuses to remove a directory it never registered as a worktree.
    rmSync(row.path, { recursive: true, force: true });
    await deleteWorktree(deps.sql, row.path);
    removed.push(row.path);
    log(`[teardown] removed ${row.path} merged=${outcome.merged}`);
  }

  // The run is finishing: nothing will resume its Codex threads.
  removeCodexHome(runId);
  return removed;
}
