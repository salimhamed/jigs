// The "./blocks" export: everything a workflow or a factory's own block may
// call. Every name is listed explicitly rather than starred in, so a name
// dropped from this file is a red test here rather than a broken import in a
// factory.
//
// Nothing here may reach a node builtin, the environment or the network: this
// specifier is imported workflow-side, where none of the three exists. The
// step implementations these blocks are handed live behind "./steps", and the
// factory's own `"use step"` wrappers are what join the two.

export {
  type ExecuteAgentStep,
  JitCheckError,
  runAgent,
  unwrapAgentStep,
} from "./agent/agent.ts";
export { type AgentOrHaltDeps, agentOrHalt } from "./agent/agent-or-halt.ts";
export { askModel, type ExecuteModelRequestStep } from "./agent/ask-model.ts";
export { type AgentSteps, bindAgentSteps } from "./agent/bind.ts";
export {
  type ClaudeHarnessConfig,
  type ClaudeHarnessOptions,
  type CodexHarnessConfig,
  type CodexHarnessOptions,
  claude,
  codex,
  type HarnessConfig,
  type HarnessName,
  type HarnessOptions,
  type McpHttpServer,
  type McpProbe,
  type McpServerConfig,
  type McpStdioServer,
  selectHarness,
} from "./agent/harness-config.ts";
export {
  type AgentStepConfig,
  type AgentWire,
  type AskStepConfig,
  type AskWire,
  buildAgentWire,
  buildAskWire,
  parseOutput,
  type WireJsonSchema,
} from "./agent/plan.ts";
export {
  type RebuildContextPrompt,
  type RebuildContextPromptInput,
  rebuildContextPrompt,
} from "./agent/rebuild-context.prompt.ts";
export type {
  AgentSession,
  AgentStepResult,
  StepResult,
  StepUsage,
} from "./agent/result.ts";
export {
  type AgentFn,
  type ResumeOrRebuildOptions,
  type ResumeOrRebuildResult,
  resumeOrRebuild,
} from "./agent/resume-or-rebuild.ts";
export {
  type ChangePatch,
  type ChangeStatus,
  type ChangeSummary,
  type FileChange,
  parseNameStatus,
  parseNumstat,
  renderChangeSummary,
} from "./git/change.ts";
export { interpolate } from "./interpolate.ts";
export {
  type PostPullRequestNoteOptions,
  type PostReviewAnswersOptions,
  postPullRequestNote,
  postReviewAnswers,
  renderChecks,
  type ThreadAnswers,
} from "./pull-request/answers.ts";
export {
  type Attend,
  attend,
  finished,
  listen,
} from "./pull-request/attend.ts";
export { bindPullRequestSteps } from "./pull-request/bind.ts";
export {
  classifyPrState,
  type GateFn,
  type GateWake,
  PR_TOKEN_PREFIX,
  type PrRef,
  type PrState,
  prToken,
  pullRequestGate,
  readPrLedger,
  tokenFromGithubPayload,
} from "./pull-request/gate.ts";
export {
  carriesMarker,
  commentSource,
  type MarkerKind,
  type MarkerLedger,
  markBody,
  type PrMarker,
  parseMarkers,
  prScope,
  readLedger,
  renderMarker,
  type StatusReason,
} from "./pull-request/marker.ts";
export {
  type ApprovalState,
  approvalState,
  isApprovalSatisfied,
  isPullRequestMergeReady,
  type MergeRefusal,
  mergeRefusal,
} from "./pull-request/merge-ready.ts";
export {
  type ApprovalSignal,
  approvalSchema,
  type MergePolicy,
  mergeSchema,
} from "./pull-request/policy.ts";
export { currentRunId, defaultPrScope } from "./pull-request/writer.ts";
export {
  bindReleaseSteps,
  type ReleasePolicy,
  type ReleaseReport,
  type ReleaseSteps,
  release,
} from "./runtime/release.ts";
export {
  type BoundReviewTicketOptions,
  bindLinearSteps,
  type LinearSteps,
} from "./ticket/bind.ts";
export {
  ClaimConflictError,
  claimTicket,
  TICKET_TOKEN_PREFIX,
  type TicketClaim,
  ticketToken,
  tokenFromLinearPayload,
} from "./ticket/claim.ts";
export {
  type CheckForTicketHumanReply,
  type Halt,
  type HaltForHumanDeps,
  type HaltForHumanFn,
  type HaltOption,
  type HaltQuestion,
  type HumanReply,
  haltForHuman,
  haltOption,
  haltQuestion,
  type JsonValue,
  NEEDS_HUMAN_TOKEN_PREFIX,
  needsHumanToken,
  type PostTicketHumanInputRequest,
} from "./ticket/halt-for-human.ts";
export { acquireTicket, type TicketPreludeSteps } from "./ticket/prelude.ts";
export {
  type Handoff,
  type PostTicketNote,
  type ReviewTicketOptions,
  reviewTicket,
  type TicketNote,
  ticketReviewVerdict,
} from "./ticket/review.ts";
export {
  renderSnapshot,
  type SnapshotComment,
  type TicketLink,
  type TicketRef,
  type TicketSnapshot,
  toSnapshot,
} from "./ticket/snapshot.ts";
export {
  type TicketReviewPrompt,
  type TicketReviewPromptInput,
  ticketReviewPrompt,
} from "./ticket/ticket-review.prompt.ts";
export { unreachable } from "./unreachable.ts";
