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
  path: string;
  branch: string;
  defaultBranch: string;
  baseSha: string;
}
