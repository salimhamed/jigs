import { deriveDefaultBranch, tryGit } from "../git.ts";

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
  keep: boolean;
  dirty: boolean;
  merged: boolean;
}

const KEEP_EVERYTHING: TeardownPlan = {
  removeWorktree: false,
  force: false,
  deleteLocalBranch: false,
  deleteRemoteBranch: false,
  preserve: null,
};

export function decideTeardown(decision: TeardownDecision): TeardownPlan {
  if (decision.keep) return { ...KEEP_EVERYTHING };
  // "Done" is the merged row, not merely the finished one: a run that
  // completed without merging still holds the only copy of its work.
  if (decision.merged) {
    // Forced: a finished worktree normally holds untracked build output that
    // plain `worktree remove` refuses, and the work itself is already merged.
    return {
      removeWorktree: true,
      force: true,
      deleteLocalBranch: true,
      deleteRemoteBranch: true,
      preserve: null,
    };
  }
  if (decision.dirty) {
    return { ...KEEP_EVERYTHING, preserve: "abandoned-dirty" };
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
  }
  if (plan.removeWorktree) {
    await tryGit(["worktree", "prune"], repoDir);
  }
}
