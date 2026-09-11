// The branch side of the review loop's step surface: what the worktree's
// commits look like and getting them onto the remote. Reaches node builtins
// through jigs' git helpers, so it is only ever imported from a step body.

import {
  commitsAhead,
  diffSince,
  headSha,
  pushBranch,
} from "../../providers/git.ts";
import { isWorktreeDirty } from "../worktree/teardown.ts";

export async function pushWorktreeBranch(
  worktreePath: string,
  branch: string,
  baseSha: string,
): Promise<{ commits: number; headSha: string; dirty: boolean }> {
  const commits = await commitsAhead(worktreePath, baseSha);
  if (commits > 0) await pushBranch(worktreePath, branch);
  const head = await headSha(worktreePath);
  // Returned alongside the commit count because the two together are what tell
  // an empty push apart: no commits and a clean tree is a builder that did
  // nothing, no commits and a dirty tree is work that can still be saved.
  const dirty = await isWorktreeDirty(worktreePath);
  return { commits, headSha: head, dirty };
}

export async function readDiff(
  worktreePath: string,
  baseSha: string,
): Promise<string> {
  return diffSince(worktreePath, baseSha);
}
