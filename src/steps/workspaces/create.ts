import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { JigsError } from "../../errors.ts";
import { deriveDefaultBranch, git, tryGit } from "../../providers/git.ts";
import type { Worktree } from "../../workflow/workspaces/worktree.ts";

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

// Fetch, never pull: refs/heads/* holds jigs' own run branches only, and each
// forks from origin/<default>. Release and prune read that ref too, and
// nothing else in those passes refreshes it.
export async function fetchOriginDefault(repoDir: string): Promise<string> {
  const defaultBranch = await resolveDefaultBranch(repoDir);
  await git(["fetch", "origin", defaultBranch], repoDir);
  return defaultBranch;
}

interface CutOptions {
  repoDir: string;
  worktreePath: string;
  branch: string;
}

type WorktreeFacts = Omit<Worktree, "binding">;

async function facts(options: CutOptions): Promise<WorktreeFacts> {
  const defaultBranch = await fetchOriginDefault(options.repoDir);
  const baseSha = await git(["rev-parse", `origin/${defaultBranch}`], options.repoDir);
  return { path: options.worktreePath, branch: options.branch, defaultBranch, baseSha };
}

export async function createWorktree(options: CutOptions): Promise<WorktreeFacts> {
  const { repoDir, worktreePath, branch } = options;
  const cut = await facts(options);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  // A worktree directory deleted without pruning leaves an admin entry that
  // makes `worktree add` at the same path fail; prune only clears entries for
  // missing, unlocked worktrees, so it is safe here.
  await tryGit(["worktree", "prune"], repoDir);
  if (existsSync(worktreePath)) {
    throw new JigsError(
      `${worktreePath} exists but is not a worktree on ${branch}; it was left untouched`,
      "inspect it, keep any work in it, then remove it and retry",
    );
  }
  // Never reset a branch: an existing one is checked out as-is, because it may
  // hold the run's work (a worktree removed mid-run, or a second provisioning
  // of the same branch). A provisioning retry's branch has no commits yet.
  const exists = await tryGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoDir,
  );
  await git(
    exists === null
      ? ["worktree", "add", "-b", branch, worktreePath, `origin/${cut.defaultBranch}`]
      : ["worktree", "add", worktreePath, branch],
    repoDir,
  );
  return cut;
}

/** The worktree a retry of this run's own provisioning left at the path, on the branch. */
export async function findWorktree(options: CutOptions): Promise<WorktreeFacts | null> {
  const { worktreePath, branch } = options;
  const toplevel = await tryGit(["rev-parse", "--show-toplevel"], worktreePath);
  if (toplevel === null) return null;
  // git reports the physical toplevel, so a symlinked component in the
  // requested path needs realpath, not lexical resolution, to match.
  if (path.resolve(toplevel) !== realpathSync(path.resolve(worktreePath))) return null;
  if ((await git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)) !== branch) return null;
  return facts(options);
}
