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
  agent,
  JitCheckError,
  type RunAgentStep,
  unwrapAgentStep,
} from "./agent/agent.ts";
export { type AgentOrHaltDeps, agentOrHalt } from "./agent/agent-or-halt.ts";
export { ask, type RunAskStep } from "./agent/ask.ts";
export {
  type ClaudeHarnessConfig,
  type CodexHarnessConfig,
  claude,
  codex,
  type HarnessConfig,
  type HarnessOptions,
  type McpHttpServer,
  type McpProbe,
  type McpServerConfig,
  type McpStdioServer,
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
  type BoundReviewTicketOptions,
  bindJigs,
  type JigsSteps,
} from "./bind-jigs.ts";
export {
  type AnswerReviewPrompt,
  type AnswerReviewPromptInput,
  answerReviewPrompt,
} from "./builder-agent/answer-review.prompt.ts";
export {
  type AnswerReviewOptions,
  answerReview,
  type ThreadAnswers,
  threadAnswers,
} from "./builder-agent/answer-review.ts";
export {
  type CodeReviewPrompt,
  type CodeReviewPromptInput,
  codeReviewPrompt,
} from "./builder-agent/code-review.prompt.ts";
export {
  type CommitWorkPrompt,
  type CommitWorkPromptInput,
  commitWorkPrompt,
} from "./builder-agent/commit-work.prompt.ts";
export {
  type CommitWorkOptions,
  commitWork,
} from "./builder-agent/commit-work.ts";
export {
  type DescribePrOptions,
  describePr,
  type PrDescription,
  prDescription,
} from "./builder-agent/describe-pr.ts";
export {
  type FixCiPrompt,
  type FixCiPromptInput,
  fixCiPrompt,
} from "./builder-agent/fix-ci.prompt.ts";
export { type FixCiOptions, fixCi } from "./builder-agent/fix-ci.ts";
export {
  type FixCiFreshPrompt,
  type FixCiFreshPromptInput,
  fixCiFreshPrompt,
} from "./builder-agent/fix-ci-fresh.prompt.ts";
export {
  type ImplementPrompt,
  type ImplementPromptInput,
  implementPrompt,
} from "./builder-agent/implement.prompt.ts";
export {
  codeReviewVerdict,
  type ImplementOptions,
  type ImplementResult,
  implementUntilCodeReviewApproves,
} from "./builder-agent/implement.ts";
export { interpolate } from "./interpolate.ts";
export {
  type PostReviewAnswersOptions,
  postReviewAnswers,
  renderChecks,
} from "./pull-request/answers.ts";
export {
  type Attend,
  attend,
  finished,
  listen,
} from "./pull-request/attend.ts";
export {
  classifyPrState,
  type GateAck,
  type GateCursor,
  type GateFn,
  type GateWake,
  PR_TOKEN_PREFIX,
  type PrRef,
  prToken,
  pullRequestGate,
  tokenFromGithubPayload,
} from "./pull-request/gate.ts";
export {
  ClaimConflictError,
  claimTicket,
  TICKET_TOKEN_PREFIX,
  type TicketClaim,
  ticketToken,
  tokenFromLinearPayload,
} from "./ticket/claim.ts";
export {
  type CheckForHumanReply,
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
  type PostNeedsHumanComment,
} from "./ticket/halt-for-human.ts";
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
