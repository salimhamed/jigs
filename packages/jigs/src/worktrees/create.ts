import { mkdirSync } from "node:fs";
import path from "node:path";
import { CliError } from "../errors.ts";
import { deriveDefaultBranch, git, tryGit } from "../git.ts";

// Every git call in this module passes an explicit absolute cwd — the
// checkout root for repo ops, the worktree path only to inspect an existing
// worktree — because removing a worktree deletes the CWD of whoever
// orchestrates (ADR 0007).

export type BranchResolution = "local" | "remote" | "new";

export interface WorktreeFacts {
  path: string;
  branch: string;
  resolution: BranchResolution;
  defaultBranch: string;
  baseSha: string;
  headSha: string;
  behindDefault: number;
}

export async function resolveDefaultBranch(
  checkoutRoot: string,
): Promise<string> {
  let branch = await deriveDefaultBranch(checkoutRoot);
  if (branch === null) {
    await tryGit(["remote", "set-head", "origin", "--auto"], checkoutRoot);
    branch = await deriveDefaultBranch(checkoutRoot);
  }
  if (branch === null) {
    throw new CliError(
      `cannot determine the default branch of ${checkoutRoot}`,
      "set it: git remote set-head origin --auto",
    );
  }
  return branch;
}

// The freshness gate is fetch, never pull: the human checkout's local default
// branch stays untouched, and new branches fork from origin/<default>.
export async function fetchFreshness(
  checkoutRoot: string,
  defaultBranch: string,
  branch: string,
): Promise<void> {
  await git(["fetch", "origin", defaultBranch], checkoutRoot);
  if (branch !== defaultBranch) {
    // Non-fatal: the branch may not exist upstream yet.
    await tryGit(["fetch", "origin", branch], checkoutRoot);
  }
}

export interface CreateWorktreeOptions {
  checkoutRoot: string;
  worktreePath: string;
  branch: string;
}

export async function createWorktree(
  options: CreateWorktreeOptions,
): Promise<WorktreeFacts> {
  const { checkoutRoot, worktreePath, branch } = options;
  const defaultBranch = await resolveDefaultBranch(checkoutRoot);
  await fetchFreshness(checkoutRoot, defaultBranch, branch);
  const baseSha = await git(
    ["rev-parse", `origin/${defaultBranch}`],
    checkoutRoot,
  );
  mkdirSync(path.dirname(worktreePath), { recursive: true });

  const localRef = await tryGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    checkoutRoot,
  );
  const remoteRef = await tryGit(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    checkoutRoot,
  );

  let resolution: BranchResolution;
  if (localRef !== null) {
    // Checked out as-is, never auto-reset — even when origin/<branch> moved.
    resolution = "local";
    await git(["worktree", "add", worktreePath, branch], checkoutRoot);
  } else if (remoteRef !== null) {
    resolution = "remote";
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
      checkoutRoot,
    );
  } else {
    resolution = "new";
    await git(
      [
        "worktree",
        "add",
        worktreePath,
        "-b",
        branch,
        `origin/${defaultBranch}`,
      ],
      checkoutRoot,
    );
  }

  const headSha = await git(
    ["rev-parse", `refs/heads/${branch}`],
    checkoutRoot,
  );
  const behindDefault = Number(
    await git(
      ["rev-list", "--count", `${branch}..origin/${defaultBranch}`],
      checkoutRoot,
    ),
  );
  return {
    path: worktreePath,
    branch,
    resolution,
    defaultBranch,
    baseSha,
    headSha,
    behindDefault,
  };
}

export interface WorktreeStatusOptions {
  checkoutRoot: string;
  worktreePath: string;
  branch: string;
}

export interface WorktreeStatus {
  exists: boolean;
  branchMatches: boolean;
  clean: boolean;
  diverged: boolean;
  headSha: string | null;
  behindDefault: number | null;
  defaultBranch: string | null;
  baseSha: string | null;
}

export async function worktreeStatus(
  options: WorktreeStatusOptions,
): Promise<WorktreeStatus> {
  const { checkoutRoot, worktreePath, branch } = options;
  const toplevel = await tryGit(["rev-parse", "--show-toplevel"], worktreePath);
  if (
    toplevel === null ||
    path.resolve(toplevel) !== path.resolve(worktreePath)
  ) {
    return {
      exists: false,
      branchMatches: false,
      clean: false,
      diverged: false,
      headSha: null,
      behindDefault: null,
      defaultBranch: null,
      baseSha: null,
    };
  }

  const defaultBranch = await resolveDefaultBranch(checkoutRoot);
  await fetchFreshness(checkoutRoot, defaultBranch, branch);
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
    checkoutRoot,
  );
  let diverged = false;
  if (remoteSha !== null && remoteSha !== headSha) {
    const mergeBase = await tryGit(
      ["merge-base", headSha, remoteSha],
      checkoutRoot,
    );
    diverged = mergeBase !== headSha && mergeBase !== remoteSha;
  }

  const behindDefault = Number(
    await git(
      ["rev-list", "--count", `${headSha}..origin/${defaultBranch}`],
      checkoutRoot,
    ),
  );
  const baseSha = await git(
    ["rev-parse", `origin/${defaultBranch}`],
    checkoutRoot,
  );
  return {
    exists: true,
    branchMatches: checkedOut === branch,
    clean,
    diverged,
    headSha,
    behindDefault,
    defaultBranch,
    baseSha,
  };
}
