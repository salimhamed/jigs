import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../errors.ts";
import { deriveDefaultBranch, git, tryGit } from "../git.ts";
import type { WorktreeFacts } from "./facts.ts";

// Every git call in this module passes an explicit absolute cwd — the
// binding's bare clone for repo ops, the worktree path only to inspect an
// existing worktree — because removing a worktree deletes the CWD of whoever
// orchestrates.

async function resolveDefaultBranch(repoDir: string): Promise<string> {
  let branch = await deriveDefaultBranch(repoDir);
  if (branch === null) {
    await tryGit(["remote", "set-head", "origin", "--auto"], repoDir);
    branch = await deriveDefaultBranch(repoDir);
  }
  if (branch === null) {
    throw new JigsError(
      `cannot determine the default branch of ${repoDir}`,
      "set it: git remote set-head origin --auto",
    );
  }
  return branch;
}

const missingRemoteRef = (err: unknown): boolean =>
  /couldn't find remote ref/i.test(
    String((err as { stderr?: string }).stderr ?? ""),
  );

// The freshness gate is fetch, never pull: refs/heads/* holds jigs' own run
// branches only, and new branches fork from origin/<default>.
async function fetchFreshness(
  repoDir: string,
  defaultBranch: string,
  branch: string,
): Promise<void> {
  await git(["fetch", "origin", defaultBranch], repoDir);
  if (branch === defaultBranch) return;
  try {
    await git(["fetch", "origin", branch], repoDir);
  } catch (err) {
    // Non-fatal: the branch may not exist upstream yet. But git leaves the
    // tracking ref of a branch the remote has since deleted in place, and the
    // three-way resolution would then take the remote arm and re-present the
    // pre-squash lineage of an already-merged run. Only the missing-ref case:
    // an unreachable remote must not cost a ref that is still real.
    if (!missingRemoteRef(err)) return;
    await tryGit(
      ["update-ref", "-d", `refs/remotes/origin/${branch}`],
      repoDir,
    );
  }
}

// The sweep's merge check reads refs/remotes/origin/<default>, and nothing
// else in that pass refreshes it.
export async function fetchOriginDefault(repoDir: string): Promise<void> {
  const defaultBranch = await resolveDefaultBranch(repoDir);
  await git(["fetch", "origin", defaultBranch], repoDir);
}

interface CutOptions {
  repoDir: string;
  worktreePath: string;
  branch: string;
}

export async function createWorktree(
  options: CutOptions,
): Promise<WorktreeFacts> {
  const { repoDir, worktreePath, branch } = options;
  const defaultBranch = await resolveDefaultBranch(repoDir);
  await fetchFreshness(repoDir, defaultBranch, branch);
  const baseSha = await git(["rev-parse", `origin/${defaultBranch}`], repoDir);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  // A worktree directory deleted without pruning leaves an admin entry that
  // makes `worktree add` at the same path fail; prune only clears entries for
  // missing, unlocked worktrees, so it is safe here.
  await tryGit(["worktree", "prune"], repoDir);

  const localRef = await tryGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoDir,
  );
  const remoteRef = await tryGit(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    repoDir,
  );

  if (localRef !== null) {
    // Checked out as-is, never auto-reset — even when origin/<branch> moved.
    await git(["worktree", "add", worktreePath, branch], repoDir);
  } else if (remoteRef !== null) {
    await git(
      [
        "worktree",
        "add",
        "--track",
        "-b",
        branch,
        worktreePath,
        `origin/${branch}`,
      ],
      repoDir,
    );
  } else {
    await git(
      [
        "worktree",
        "add",
        worktreePath,
        "-b",
        branch,
        `origin/${defaultBranch}`,
      ],
      repoDir,
    );
  }

  return { path: worktreePath, branch, defaultBranch, baseSha };
}

interface WorktreeStatus {
  branchMatches: boolean;
  clean: boolean;
  diverged: boolean;
  defaultBranch: string;
  baseSha: string;
}

export async function worktreeStatus(
  options: CutOptions,
): Promise<WorktreeStatus | null> {
  const { repoDir, worktreePath, branch } = options;
  const toplevel = await tryGit(["rev-parse", "--show-toplevel"], worktreePath);
  if (toplevel === null) return null;
  // git reports the physical toplevel, so a symlinked component in the
  // requested path needs realpath, not lexical resolution, to match.
  if (path.resolve(toplevel) !== realpathSync(path.resolve(worktreePath))) {
    return null;
  }

  const defaultBranch = await resolveDefaultBranch(repoDir);
  await fetchFreshness(repoDir, defaultBranch, branch);
  const checkedOut = await git(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    worktreePath,
  );
  const clean = (await git(["status", "--porcelain"], worktreePath)) === "";
  const headSha = await git(["rev-parse", "HEAD"], worktreePath);

  // Diverged = local and origin/<branch> each hold commits the other lacks;
  // behind-only or ahead-only is ff-safe and stays reusable.
  const remoteSha = await tryGit(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    repoDir,
  );
  let diverged = false;
  if (remoteSha !== null && remoteSha !== headSha) {
    const mergeBase = await tryGit(["merge-base", headSha, remoteSha], repoDir);
    diverged = mergeBase !== headSha && mergeBase !== remoteSha;
  }

  const baseSha = await git(["rev-parse", `origin/${defaultBranch}`], repoDir);
  return {
    branchMatches: checkedOut === branch,
    clean,
    diverged,
    defaultBranch,
    baseSha,
  };
}
