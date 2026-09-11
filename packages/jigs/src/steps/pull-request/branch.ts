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
export async function branchState(
  worktreePath: string,
  baseSha: string,
): Promise<{ commits: number; headSha: string; dirty: boolean }> {
  const commits = await commitsAhead(worktreePath, baseSha);
  const head = await headSha(worktreePath);
  const dirty = await isWorktreeDirty(worktreePath);
  return { commits, headSha: head, dirty };
}

// Pushes unconditionally: a push with nothing new is a successful no-op, and
// the caller that cares asks branchState first.
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<{ headSha: string }> {
  await gitPushBranch(worktreePath, branch);
  return { headSha: await headSha(worktreePath) };
}

export async function readDiff(
  worktreePath: string,
  baseSha: string,
): Promise<string> {
  return diffSince(worktreePath, baseSha);
}
