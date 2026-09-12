// What a workflow's worktree() request resolves to. Its own module because
// the shape is workflow-side — the factory's step wrappers name it through
// the "." export — while the lifecycle that produces it in
// ../steps/worktree/index.ts is step-side and full of node builtins.

export interface WorktreeFacts {
  path: string;
  branch: string;
  defaultBranch: string;
  baseSha: string;
}
