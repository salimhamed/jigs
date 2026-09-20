import { existsSync } from "node:fs";
import { deriveDefaultBranch, git, tryGit } from "../../providers/git.ts";

// The teardown matrix, split into a pure decision and its git execution so
// every row is a table test. Workflows request release only on successful completion.

export interface TeardownPlan {
  removeWorktree: boolean;
  force: boolean;
  deleteLocalBranch: boolean;
  deleteRemoteBranch: boolean;
  preserve: "abandoned-dirty" | null;
}

export interface TeardownDecision {
  dirty: boolean;
  unmergedCommits: number | null;
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
  // Automatic release never trades uncommitted work for a merged branch.
  // Dirtiness wins even when every commit is already on the default branch.
  if (decision.dirty) {
    return {
      removeWorktree: false,
      force: false,
      deleteLocalBranch: false,
      deleteRemoteBranch: false,
      preserve: "abandoned-dirty",
    };
  }
  // "Done" is the merged row, not merely the finished one: a run that
  // completed without merging still holds the only copy of its work.
  if (decision.unmergedCommits === 0) return { ...MERGED };
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

// Commits the branch holds that origin's default branch does not: zero is the
// merged answer, and null is no answer at all — an unresolvable default branch
// or ref, which callers read as unmerged because branch deletion needs
// positive evidence.
export async function countUnmergedCommits(
  repoDir: string,
  branch: string,
): Promise<number | null> {
  const defaultBranch = await deriveDefaultBranch(repoDir);
  if (defaultBranch === null) return null;
  const trackingRef = `refs/remotes/origin/${defaultBranch}`;
  const localDefault = await tryGit(["rev-parse", "--verify", trackingRef], repoDir);
  const remoteHead = await tryGit(["ls-remote", "--symref", "origin", "HEAD"], repoDir);
  if (localDefault === null || remoteHead === null) return null;
  const remoteLines = remoteHead.split("\n").filter(Boolean);
  if (remoteLines.length !== 2) return null;
  const symbolic = remoteLines
    .find((line) => line.startsWith("ref:"))
    ?.trim()
    .split(/\s+/);
  const oid = remoteLines
    .filter((line) => !line.startsWith("ref:"))
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === "HEAD");
  if (
    symbolic?.length !== 3 ||
    symbolic[0] !== "ref:" ||
    symbolic[1] !== `refs/heads/${defaultBranch}` ||
    symbolic[2] !== "HEAD" ||
    oid?.length !== 2 ||
    oid[0] !== localDefault
  ) {
    return null;
  }
  const count = await tryGit(["rev-list", "--count", branch, `^${trackingRef}`], repoDir);
  if (count === null) return null;
  const commits = Number(count);
  return count.trim() !== "" && Number.isInteger(commits) && commits >= 0 ? commits : null;
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const status = await tryGit(["status", "--porcelain"], worktreePath);
  return status === null || status !== "";
}

export interface AppliedTeardown {
  localBranchDeleted: boolean;
  remoteBranchDeleted: boolean;
}

export async function applyTeardown(
  plan: TeardownPlan,
  target: ApplyTeardownTarget,
): Promise<AppliedTeardown> {
  const { repoDir, worktreePath, branch } = target;
  const result = { localBranchDeleted: false, remoteBranchDeleted: false };
  if (!plan.removeWorktree) return result;
  if (existsSync(worktreePath)) {
    const args = ["worktree", "remove", worktreePath];
    if (plan.force) args.push("--force");
    // A locked tree or failed Git operation is evidence to preserve, not a reason to rm -rf.
    await git(args, repoDir);
  }
  await git(["worktree", "prune"], repoDir);
  // Pin and recheck refs before deleting; an independently advanced branch stays.
  if (plan.deleteLocalBranch) {
    const ref = `refs/heads/${branch}`;
    const sha = await tryGit(["rev-parse", "--verify", ref], repoDir);
    if (sha !== null && (await countUnmergedCommits(repoDir, sha)) === 0) {
      result.localBranchDeleted = (await tryGit(["update-ref", "-d", ref, sha], repoDir)) !== null;
    }
  }
  if (plan.deleteRemoteBranch) {
    const ref = `refs/heads/${branch}`;
    const remote = await tryGit(["ls-remote", "--heads", "origin", ref], repoDir);
    const sha = remote?.split("\t")[0];
    if (sha && (await countUnmergedCommits(repoDir, sha)) === 0) {
      result.remoteBranchDeleted =
        (await tryGit(
          ["push", `--force-with-lease=${ref}:${sha}`, "origin", `:${ref}`],
          repoDir,
        )) !== null;
    }
    // A failed push must not erase the only tracking evidence of the remote branch.
    if (remote === "" || result.remoteBranchDeleted) {
      const tracking = `refs/remotes/origin/${branch}`;
      const trackedSha = await tryGit(["rev-parse", "--verify", tracking], repoDir);
      if (trackedSha !== null && (await countUnmergedCommits(repoDir, trackedSha)) === 0) {
        await tryGit(["update-ref", "-d", tracking, trackedSha], repoDir);
      }
    }
  }
  return result;
}
