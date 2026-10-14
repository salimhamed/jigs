// What a workflow's worktree() request resolves to. Its own module because
// the shape lives in workflow/ — the factory's step wrappers name it through
// the "." export — while the lifecycle that produces it in
// ../steps/workspaces/index.ts is step-side and full of node builtins.

/**
 * A provisioned repository worktree and the commit it was cut from.
 *
 * @group Runtime and resources
 */
export interface Worktree {
  /** The named repository binding in the factory configuration. */
  binding: string;
  /** The binding's GitHub installation, as named on the hub, that reaches its repository. */
  installationName: string;
  path: string;
  branch: string;
  defaultBranch: string;
  baseSha: string;
}

/**
 * A worktree checked out at a pull request's head commit, with no branch of its own.
 *
 * @remarks
 * It is for checking the pull request as it stands, so it cannot be pushed. Pass `headSha` to
 * `mergePullRequest` to merge exactly the commit that was checked. Commits made in it are not
 * kept when the run's resources are released.
 *
 * @group Runtime and resources
 */
export interface PullRequestWorktree {
  /** The named repository binding in the factory configuration. */
  binding: string;
  /** The binding's GitHub installation, as named on the hub, that reaches its repository. */
  installationName: string;
  path: string;
  /** The pull request's head commit, which the worktree is checked out at. */
  headSha: string;
}
