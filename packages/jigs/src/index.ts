export type { CheckOutcome, CheckReport } from "./checks/catalog.ts";
export { type BindResult, bindRepo } from "./commands/bind.ts";
export { type BindingRow, listBindings } from "./commands/bindings.ts";
export { type BuildDeps, buildFactoryService } from "./commands/build.ts";
export { type CancelResult, cancelRun } from "./commands/cancel.ts";
export { runDoctor } from "./commands/doctor.ts";
export { type InitResult, initFactory } from "./commands/init.ts";
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
  type SweepEntry,
  type SweepOptions,
  type SweepResult,
  sweepWorktrees,
} from "./commands/sweep.ts";
export { unbindRepo } from "./commands/unbind.ts";
export { type Binding, resolveBinding } from "./config/factory-config.ts";
export { locateFactoryRoot } from "./config/locate-factory.ts";
export { CliError } from "./errors.ts";
// The worktree lifecycle and the review loop live in the service package but
// their git and remote-parsing substrate is jigs', and the service imports
// jigs by package name.
export {
  commitsAhead,
  deriveDefaultBranch,
  diffSince,
  git,
  headSha,
  pushBranch,
  type ResolvedRemote,
  resolveRemoteUrl,
  tryGit,
} from "./git.ts";
export { type GithubRepoRef, parseGithubRemote } from "./github-webhook.ts";
// The service tears down a run's managed home from the worktree lifecycle,
// and jigs/harnesses is provider re-exports only, so the door is here.
export { removeManagedCodexHome } from "./harnesses/codex-home.ts";
export {
  type BindingClone,
  bindingClones,
  type EnsureBindingCloneOptions,
  ensureBindingClone,
  hasBindingClone,
} from "./worktrees/clone.ts";
export type { BranchResolution, WorktreeFacts } from "./worktrees/facts.ts";
export {
  type BindingDirOptions,
  bindingDir,
  bindingRepoDir,
  type WorktreePathOptions,
  worktreePath,
} from "./worktrees/layout.ts";
