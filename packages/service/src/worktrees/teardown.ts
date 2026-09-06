import { rmSync } from "node:fs";
import { deriveDefaultBranch, removeManagedCodexHome, tryGit } from "jigs";
import type { Sql } from "postgres";
import { deleteWorktree, listWorktreesForRun } from "./registry";

// The teardown matrix (ADR 0007), split into a pure decision and its git
// execution so every row is a table test. Teardown is runtime-owned: authors
// never write cleanup, because an author `finally` would fire on suspension.

export interface TeardownPlan {
  removeWorktree: boolean;
  force: boolean;
  deleteLocalBranch: boolean;
  deleteRemoteBranch: boolean;
  preserve: "abandoned-dirty" | null;
}

export interface TeardownDecision {
  dirty: boolean;
  merged: boolean;
}

// Forced: a finished worktree normally holds untracked build output that
// plain `worktree remove` refuses, and the work itself is already merged.
const MERGED: TeardownPlan = {
  removeWorktree: true,
  force: true,
  deleteLocalBranch: true,
  deleteRemoteBranch: true,
  preserve: null,
};

export function decideTeardown(decision: TeardownDecision): TeardownPlan {
  // "Done" is the merged row, not merely the finished one: a run that
  // completed without merging still holds the only copy of its work.
  if (decision.merged) return { ...MERGED };
  if (decision.dirty) {
    return {
      removeWorktree: false,
      force: false,
      deleteLocalBranch: false,
      deleteRemoteBranch: false,
      preserve: "abandoned-dirty",
    };
  }
  // Branches stay as the only cheap copy of unmerged agent work.
  return {
    removeWorktree: true,
    force: false,
    deleteLocalBranch: false,
    deleteRemoteBranch: false,
    preserve: null,
  };
}

export interface ApplyTeardownTarget {
  repoDir: string;
  worktreePath: string;
  branch: string;
}

// Unresolvable default branch or remote ref reads as not merged: the whole
// point of the flag is that branch deletion needs positive evidence.
export async function isBranchMerged(
  repoDir: string,
  branch: string,
): Promise<boolean> {
  const defaultBranch = await deriveDefaultBranch(repoDir);
  if (defaultBranch === null) return false;
  const merged = await tryGit(
    [
      "merge-base",
      "--is-ancestor",
      branch,
      `refs/remotes/origin/${defaultBranch}`,
    ],
    repoDir,
  );
  return merged !== null;
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const status = await tryGit(["status", "--porcelain"], worktreePath);
  return status !== null && status !== "";
}

export async function applyTeardown(
  plan: TeardownPlan,
  target: ApplyTeardownTarget,
): Promise<void> {
  const { repoDir, worktreePath, branch } = target;
  if (plan.removeWorktree) {
    const args = ["worktree", "remove", worktreePath];
    if (plan.force) args.push("--force");
    // Tolerated: the directory may already be gone, which prune settles.
    await tryGit(args, repoDir);
  }
  // Branch deletion strictly after removal — git refuses to delete a branch
  // still checked out in a worktree.
  if (plan.deleteLocalBranch) {
    await tryGit(["branch", "-D", branch], repoDir);
  }
  if (plan.deleteRemoteBranch) {
    // Idempotent by construction: git exits non-zero when the remote ref is
    // already gone, which is the normal case under GitHub delete-on-merge.
    await tryGit(["push", "origin", "--delete", branch], repoDir);
    // That failed push leaves the tracking ref behind, and a re-run of the
    // same ticket branch would fork from it — the pre-squash lineage, whose
    // commits are already merged. Tolerated: a push that did delete took the
    // ref with it.
    await tryGit(
      ["update-ref", "-d", `refs/remotes/origin/${branch}`],
      repoDir,
    );
  }
  if (plan.removeWorktree) {
    await tryGit(["worktree", "prune"], repoDir);
  }
}

// The per-run teardown a pipeline calls after a merged reviewLoop return.
// The loop only returns merged, so this is the matrix's merged row as a fixed
// recipe rather than a decision: no dirtiness read (the forced remove takes
// build output with it), and "merged" never derived — a squash merge leaves
// the branch tip un-ancestored, so isBranchMerged's `merge-base --is-ancestor`
// would answer false and the done row would silently degrade to the failed
// one. The full matrix stays with the sweep, where the outcome is unknown.
//
// Deliberately not a filtered `sweepWorktrees`: the sweep's classifier answers
// "is somebody else's leftover reclaimable", and it answers `held` for a run
// still executing its own body. The operator's `jigs sweep` is the net for
// runs that never reach here — nothing reclaims a worktree unattended.

export interface TeardownRunDeps {
  sql: Sql;
  removeCodexHome?: (runKey: string) => void;
  log?: (line: string) => void;
}

export async function teardownMergedRun(
  runId: string,
  deps: TeardownRunDeps,
): Promise<string[]> {
  const removeCodexHome = deps.removeCodexHome ?? removeManagedCodexHome;
  const log = deps.log ?? ((line: string) => console.log(line));

  const rows = await listWorktreesForRun(deps.sql, runId);
  const removed: string[] = [];
  for (const row of rows) {
    await applyTeardown(MERGED, {
      repoDir: row.repoDir,
      worktreePath: row.path,
      branch: row.branch,
    });
    // git refuses to remove a directory it never registered as a worktree.
    rmSync(row.path, { recursive: true, force: true });
    await deleteWorktree(deps.sql, row.path);
    removed.push(row.path);
    log(`[teardown] removed ${row.path}`);
  }

  // The run is finishing: nothing will resume its Codex threads.
  removeCodexHome(runId);
  return removed;
}
