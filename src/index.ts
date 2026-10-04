/**
 * Factory and workflow definitions, harness and model descriptors, types and pure helpers.
 *
 * Durable steps and routines come from the factory-generated `#jigs/steps` and
 * `#jigs/routines`.
 *
 * @example
 * ```ts
 * import { defineWorkflow, harnesses } from "@jigs-ai/jigs";
 * import { runAgent } from "#jigs/routines";
 * ```
 *
 * @module jigs
 * @packageDocumentation
 */

export { JitCheckError, unwrapAgentStep } from "./workflow/agents/agent.ts";
export { type GithubMcpOptions, githubMcp } from "./workflow/agents/github-mcp.ts";
export {
  type AgentGithub,
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
  type HarnessSkills,
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
export { type LinearMcpOptions, linearMcp } from "./workflow/agents/linear-mcp.ts";
export {
  type PagerdutyMcpOptions,
  pagerdutyMcp,
} from "./workflow/agents/pagerduty-mcp.ts";
export type {
  AgentRequest,
  AskAgentOptions,
  AskModelOptions,
  ModelRequest,
  OutputJsonSchema,
  RunAgentOptions,
} from "./workflow/agents/plan.ts";
export {
  type AgentResult,
  type AgentSessionRef,
  describeHarness,
  type ModelResult,
} from "./workflow/agents/result.ts";
export type {
  FindingResponse,
  ReviewFinding,
  ReviewRound,
} from "./workflow/delivery/answers.ts";
export type {
  BuildAndReviewOptions,
  BuildApproved,
  BuildDelivery,
  BuildResult,
  BuildStopped,
} from "./workflow/delivery/build-and-review.ts";
export type {
  BuildFacts,
  Delivery,
  DeliveryPrompts,
  MaintainFacts,
  ReviewFacts,
  UnpublishedWork,
} from "./workflow/delivery/delivery.ts";
export type {
  DescribeDelivery,
  Described,
  DescribeOptions,
} from "./workflow/delivery/describe.ts";
export type {
  FollowDelivery,
  FollowOptions,
  FollowResult,
  NeedsHuman,
} from "./workflow/delivery/follow.ts";
export type { PublishDelivery, PublishOptions } from "./workflow/delivery/publish.ts";
export { builderWakeFacts } from "./workflow/delivery/wake.ts";
export { JigsError } from "./workflow/errors.ts";
export {
  type AgentsDefinition,
  type BindingDefinition,
  defineFactory,
  defineWorkflow,
  type EventTrigger,
  type Factory,
  type FactoryDefinition,
  type GitHubDefinition,
  type LinearDefinition,
  type PagerDutyDefinition,
  type Schedule,
  type SlackDefinition,
  type SourceDescriptor,
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
export { type TicketNote, ticketReviewVerdictSchema } from "./workflow/linear/review.ts";
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
export type { IncidentRef, IncidentSnapshot } from "./workflow/pagerduty/snapshot.ts";
export { type PagerDutyIncidentsParams, pagerduty } from "./workflow/pagerduty/source.ts";

export { renderChecks } from "./workflow/pull-requests/answers.ts";
export {
  type PullRequestMarker,
  parseMarkers,
  type StatusReason,
} from "./workflow/pull-requests/marker.ts";
export { blockedMergeNote, isPullRequestMergeReady } from "./workflow/pull-requests/merge-ready.ts";
export type { ApprovalCoverage } from "./workflow/pull-requests/policy.ts";
export type {
  PullRequestReadOptions,
  PullRequestRef,
} from "./workflow/pull-requests/pull-request.ts";
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
export type {
  ResourceRecord,
  ResourceState,
  RunResource,
} from "./workflow/runtime/resources.ts";
export type { SlackAuthor, SlackMessageSnapshot, SlackPost } from "./workflow/slack/snapshot.ts";
export { slack } from "./workflow/slack/sources.ts";
export type { SlackQuestion, SlackReplyResult } from "./workflow/slack/wait-for-reply.ts";
export { unreachable } from "./workflow/unreachable.ts";
export type { Worktree } from "./workflow/workspaces/worktree.ts";
