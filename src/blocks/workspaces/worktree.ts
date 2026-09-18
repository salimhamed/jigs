// What a workflow's worktree() request resolves to. Its own module because
// the shape is workflow-side — the factory's step wrappers name it through
// the "." export — while the lifecycle that produces it in
// ../steps/workspaces/index.ts is step-side and full of node builtins.

export interface Worktree {
  path: string;
  branch: string;
  defaultBranch: string;
  baseSha: string;
}
