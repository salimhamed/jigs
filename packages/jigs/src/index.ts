export type { CheckOutcome, CheckReport } from "./checks/catalog.ts";
export { type BindResult, bindRepo } from "./commands/bind.ts";
export { type BindingRow, listBindings } from "./commands/bindings.ts";
export { type CancelResult, cancelRun } from "./commands/cancel.ts";
export { runDoctor } from "./commands/doctor.ts";
export { type LogsResult, showLogs } from "./commands/logs.ts";
export { type PokeResult, pokeRun } from "./commands/poke.ts";
export {
  listRunsForPs,
  type PsResult,
  type PsRun,
  type PsWorktree,
} from "./commands/ps.ts";
export {
  type LaunchResult,
  launchRun,
  parseInputs,
  validateInputs,
} from "./commands/run.ts";
export type { ServiceDeps } from "./commands/service.ts";
export { unbindRepo } from "./commands/unbind.ts";
export { locateFactoryRoot } from "./config/locate-factory.ts";
export { CliError } from "./errors.ts";
export { formatTable } from "./table.ts";
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
