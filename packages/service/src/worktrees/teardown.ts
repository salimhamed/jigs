import { rmSync } from "node:fs";
import {
  applyTeardown,
  decideTeardown,
  isWorktreeDirty,
  removeManagedCodexHome,
} from "jigs";
import type { Sql } from "postgres";
import {
  deleteWorktree,
  listWorktreesForRun,
  setWorktreeState,
} from "./registry";

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
// requires; the operator's `jigs sweep` is the net for runs that never reach
// here — nothing reclaims a worktree unattended.

export interface TeardownRunDeps {
  sql: Sql;
  removeCodexHome?: (runKey: string) => void;
  log?: (line: string) => void;
}

export async function teardownRun(
  runId: string,
  outcome: { merged: boolean },
  deps: TeardownRunDeps,
): Promise<string[]> {
  const removeCodexHome = deps.removeCodexHome ?? removeManagedCodexHome;
  const log = deps.log ?? ((line: string) => console.log(line));

  const rows = await listWorktreesForRun(deps.sql, runId);
  const removed: string[] = [];
  for (const row of rows) {
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
      repoDir: row.repoDir,
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
