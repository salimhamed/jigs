// The branch side of the review loop's step surface: what the worktree's
// commits look like, and getting them onto the remote. Reaches node builtins
// through jigs' git helpers, so it is only ever imported from a step body.

import {
  commitsAhead,
  diffSince,
  pushBranch as gitPushBranch,
  headSha,
} from "../../providers/git.ts";
import { isWorktreeDirty } from "../worktree/teardown.ts";

// Three reads and no side effect, so a caller can ask what is on the branch
// before deciding whether to push. The commit count and the dirty flag
// together are what tell an empty branch apart: no commits and a clean tree is
// a builder that did nothing, no commits and a dirty tree is work that can
// still be saved.
/** Check for new commits and uncommitted changes before pushing a branch. */
export async function readBranchState(
  worktreePath: string,
  baseSha: string,
): Promise<{ commits: number; headSha: string; dirty: boolean }> {
  const commits = await commitsAhead(worktreePath, baseSha);
  const head = await headSha(worktreePath);
  const dirty = await isWorktreeDirty(worktreePath);
  return { commits, headSha: head, dirty };
}

// Pushes unconditionally: a push with nothing new is a successful no-op, and
// the caller that cares asks readBranchState first.
/** Push the worktree branch to its remote. */
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<{ headSha: string }> {
  await gitPushBranch(worktreePath, branch);
  return { headSha: await headSha(worktreePath) };
}

/** Read committed changes since the base commit. Large diffs are truncated. */
export async function readWorktreeDiff(worktreePath: string, baseSha: string): Promise<string> {
  return diffSince(worktreePath, baseSha);
}
