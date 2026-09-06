// What a pipeline's worktree() request resolves to. The lifecycle that
// produces it lives in @jigs/service/worktrees; the shape stays here because
// the factory's step wrappers import it from jigs.

export interface WorktreeFacts {
  path: string;
  branch: string;
  defaultBranch: string;
  baseSha: string;
}
