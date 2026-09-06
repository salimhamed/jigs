// What a pipeline's worktree() request resolves to. The lifecycle that
// produces it lives in @jigs/service/worktrees; the shape stays here because
// the factory's step wrappers import it from jigs.

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
