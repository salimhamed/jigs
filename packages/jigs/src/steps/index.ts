// The "./steps" export: the implementations a factory wraps in its own
// `"use step"` functions, and nothing else. Every one of them reaches a node
// builtin, the environment or the network, which is exactly why it is a step —
// so this specifier must never be imported from a pipeline or a block, only
// from inside a wrapper body the directive transform erases.

export {
  type ExecuteDeps,
  realDeps,
  runAgent,
} from "./agent/run-agent.ts";
export { runAsk } from "./agent/run-ask.ts";
export {
  jigsPromptSources,
  jigsPrompts,
  withPrompts,
} from "./prompts/jigs-prompts.ts";
export {
  createPromptRegistry,
  type PromptCheckFailure,
  type PromptData,
  type PromptRegistry,
  type PromptRegistryOptions,
  type PromptSource,
} from "./prompts/registry.ts";
export { branchState, pushBranch, readDiff } from "./pull-request/branch.ts";
export { fetchPrState } from "./pull-request/fetch-state.ts";
export {
  commentOnPr,
  openPr,
  replyInThread,
  resolveRepo,
  squashMerge,
} from "./pull-request/pr.ts";
export { dashboardRunUrl } from "./run-context.ts";
export { fetchSnapshot } from "./ticket/fetch-snapshot.ts";
export {
  createComment,
  createIssueInProject,
  findIssueInProject,
  type LinearIssueMatch,
} from "./ticket/issues.ts";
export {
  checkForHumanReply,
  type NeedsHumanContext,
  postNeedsHumanComment,
  postTicketNote,
} from "./ticket/needs-human-comments.ts";
export {
  type ProvisionRunWorktreeDeps,
  provisionRunWorktree,
  teardownMergedRun,
  teardownRunWorktrees,
  type WorktreeRequest,
} from "./worktree/index.ts";
