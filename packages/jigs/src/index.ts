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
export { type LaunchResult, launchRun } from "./commands/run.ts";
export {
  type SweepOptions,
  type SweepResult,
  sweepWorktrees,
} from "./commands/sweep.ts";
export { unbindRepo } from "./commands/unbind.ts";
export {
  type ResolvedBinding,
  resolveBinding,
  resolveBindings,
} from "./config/factory-config.ts";
export { locateFactoryRoot } from "./config/locate-factory.ts";
export {
  parseTargetConfig,
  readTargetConfig,
  TARGET_CONFIG_FILE,
  type TargetConfig,
  type TargetWorktreeConfig,
} from "./config/target-config.ts";
export { CliError } from "./errors.ts";
// The service tears down a run's managed home from the worktree lifecycle,
// and jigs/harnesses is provider re-exports only, so the door is here.
export { removeManagedCodexHome } from "./harnesses/codex-home.ts";
export {
  type BranchResolution,
  type CreateWorktreeOptions,
  createWorktree,
  type WorktreeFacts,
  type WorktreeStatus,
  worktreeStatus,
} from "./worktrees/create.ts";
export {
  describeFf,
  type FastForwardOptions,
  type FfResult,
  type FfSkip,
  fastForwardDefaultBranch,
} from "./worktrees/fast-forward.ts";
export {
  type WorktreePathOptions,
  worktreeParentDir,
  worktreePath,
} from "./worktrees/layout.ts";
export {
  PostCreateFailedError,
  type ProvisionResult,
  type ProvisionWorktreeOptions,
  provisionWorktree,
} from "./worktrees/provision.ts";
export {
  decideReuse,
  type NotReusableReason,
  type ReuseDiskFacts,
  type ReuseInput,
  type ReuseRegistration,
  WorktreeNotReusableError,
  WorktreeOwnedError,
} from "./worktrees/reuse.ts";
export {
  classifySweep,
  type SweepEntry,
  type SweepInput,
  type SweepState,
} from "./worktrees/sweep.ts";
export {
  applyTeardown,
  decideTeardown,
  isWorktreeDirty,
  type RunOutcome,
  type TeardownDecision,
  type TeardownPlan,
} from "./worktrees/teardown.ts";
