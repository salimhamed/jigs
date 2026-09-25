/**
 * Everything a factory's configuration and workflows import from jigs: the factory and workflow
 * definitions, harness and model descriptors, the data steps hand back, question helpers, and
 * pure renderers.
 *
 * Steps and routines come from your factory's generated `#jigs/steps` and `#jigs/routines`.
 *
 * @module jigs
 * @packageDocumentation
 */

export { JitCheckError, unwrapAgentStep } from "./workflow/agents/agent.ts";
export {
  type AskableHarness,
  type AskableModelSource,
  type ClaudeHarness,
  type ClaudeHarnessSettings,
  type ClaudePolicyKey,
  type CodexHarness,
  type CodexHarnessSettings,
  type CodexPolicyKey,
  type Harness,
  type HarnessForOptions,
  type HarnessKind,
  harnesses,
  harnessKinds,
  type JsonOnly,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpStdioServerConfig,
  type McpToolProbe,
  type ModelKind,
  type ModelSource,
  models,
  type OpenaiCodexSource,
  type OpenaiCompatibleSource,
  type OpenrouterSource,
  type PiHarness,
  type PiHarnessOptions,
  type PiMcpHttpServerConfig,
  type PiMcpServerConfig,
  type PiMcpStdioServerConfig,
  type PiOpenaiCompatibleHarness,
  type PiOpenaiCompatibleOptions,
  type PiOtherHarness,
  type ToolFree,
} from "./workflow/agents/harness-config.ts";
export {
  type AskJevOptions,
  type ChoiceQuestion,
  choice,
  type JevAnswer,
  type JevAnswers,
  type JevQuestion,
  type JevQuestions,
  type JevResult,
  type JevState,
  type ScoreQuestion,
  score,
  type YesNoQuestion,
  yesNo,
} from "./workflow/agents/jev.ts";
export type {
  AgentRequest,
  AskAgentOptions,
  AskModelOptions,
  ModelRequest,
  OutputJsonSchema,
  RunAgentOptions,
} from "./workflow/agents/plan.ts";
export {
  type RebuildContextPrompt,
  type RebuildContextPromptInput,
  rebuildContextPrompt,
} from "./workflow/agents/rebuild-context.prompt.ts";
export {
  type AgentResult,
  type AgentSessionRef,
  describeHarness,
  type ModelResult,
} from "./workflow/agents/result.ts";
export { JigsError } from "./workflow/errors.ts";
export {
  type AgentsDefinition,
  type BindingDefinition,
  defineFactory,
  defineWorkflow,
  type Factory,
  type FactoryDefinition,
  type GitHubDefinition,
  type LinearDefinition,
  type Schedule,
  type TicketWorkflowInputs,
  ticketInputSchema,
  type WebhooksDefinition,
  type WorkflowDefinition,
  type WorkflowInputs,
} from "./workflow/factory.ts";
export {
  type ChangePatch,
  type ChangeStatus,
  type ChangeSummary,
  type FileChange,
  renderChangeSummary,
} from "./workflow/git/change.ts";
export {
  type HaltOption,
  type HaltQuestion,
  haltOptionSchema,
  haltQuestionSchema,
  type JsonValue,
} from "./workflow/human/questions.ts";
export { interpolate } from "./workflow/interpolate.ts";

export { ClaimConflictError, type TicketClaim } from "./workflow/linear/claim.ts";
export type { Halt, HumanReply } from "./workflow/linear/halt-for-human.ts";
export {
  type TicketHandoff,
  type TicketNote,
  ticketReviewVerdictSchema,
} from "./workflow/linear/review.ts";
export {
  renderTicketSnapshot,
  type TicketComment,
  type TicketLink,
  type TicketRef,
  type TicketSnapshot,
} from "./workflow/linear/snapshot.ts";
export {
  type TicketReviewPrompt,
  type TicketReviewPromptInput,
  ticketReviewPrompt,
} from "./workflow/linear/ticket-review.prompt.ts";

export { renderChecks, type ThreadAnswers } from "./workflow/pull-requests/answers.ts";
export type { PullRequestRef, PullRequestWake } from "./workflow/pull-requests/gate.ts";
export {
  type PullRequestMarker,
  parseMarkers,
  type StatusReason,
} from "./workflow/pull-requests/marker.ts";
export { isPullRequestMergeReady } from "./workflow/pull-requests/merge-ready.ts";
export {
  type ApprovalState,
  type CheckRun,
  type PullRequestApproval,
  type PullRequestComment,
  type PullRequestReview,
  type PullRequestSnapshot,
  pullRequestSnapshotKey,
  type ReviewComment,
  type ReviewThread,
} from "./workflow/pull-requests/snapshot.ts";
export { defaultPullRequestScope } from "./workflow/pull-requests/writer.ts";

export type { ReleasePolicy, ReleaseReport } from "./workflow/runtime/release.ts";
export type { RunResource } from "./workflow/runtime/resources.ts";
export { unreachable } from "./workflow/unreachable.ts";
export type { Worktree } from "./workflow/workspaces/worktree.ts";
