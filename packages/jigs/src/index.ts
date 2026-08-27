export { type BindResult, bindRepo } from "./commands/bind.ts";
export { type BindingRow, listBindings } from "./commands/bindings.ts";
export { unbindRepo } from "./commands/unbind.ts";
export { CliError } from "./errors.ts";
export {
  type BranchResolution,
  type CreateWorktreeOptions,
  createWorktree,
  type WorktreeFacts,
  type WorktreeStatus,
  type WorktreeStatusOptions,
  worktreeStatus,
} from "./worktrees/create.ts";
export {
  type WorktreePathOptions,
  worktreePath,
} from "./worktrees/layout.ts";
export {
  decideReuse,
  type NotReusableReason,
  type ReuseDiskFacts,
  type ReuseInput,
  type ReuseRegistration,
  WorktreeNotReusableError,
  WorktreeOwnedError,
} from "./worktrees/reuse.ts";
