export type { CheckOutcome, CheckReport } from "./checks/catalog.ts";
export { type BindResult, bindRepo } from "./commands/bind.ts";
export { type BindingRow, listBindings } from "./commands/bindings.ts";
export { runDoctor } from "./commands/doctor.ts";
export { type PokeResult, pokeRun } from "./commands/poke.ts";
export { unbindRepo } from "./commands/unbind.ts";
export { locateFactoryRoot } from "./config/locate-factory.ts";
export { CliError } from "./errors.ts";
export {
  type BranchResolution,
  type CreateWorktreeOptions,
  createWorktree,
  type WorktreeFacts,
  type WorktreeStatus,
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
