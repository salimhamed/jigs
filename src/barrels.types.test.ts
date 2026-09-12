// The type half of what the barrels export. package.test.ts asserts the value
// names with a runtime import, which cannot see a type at all: a `TicketRef` or
// a `JsonValue` dropped from blocks/index.ts would pass every test in this repo
// and break a factory on install. `/delivery` is almost entirely types, so a
// rename there is invisible to every runtime assertion. Here the guard is tsc —
// `pnpm typecheck` fails when one of these names stops being exported.

import { expect, test } from "vitest";
import type {
  ApprovedChange,
  CiRepairAgent,
  CiRepairPromptContext,
  DeliverChangeOptions,
  DeliveryAgent,
  DeliveryAttempts,
  DeliveryChange,
  DeliveryLimits,
  DeliveryPhase,
  DeliveryResult,
  DeliverySteps,
  DeliveryStopped,
  DescriptionAgent,
  DescriptionPromptContext,
  FollowPullRequestOptions,
  ImplementAndReviewOptions,
  ImplementAndReviewResult,
  ImplementationAgent,
  ImplementationPromptContext,
  LimitDecision,
  LimitReached,
  OnDeliveryLimit,
  PublishApprovedChangeOptions,
  PullRequestRevisionAgent,
  PullRequestRevisionPromptContext,
  ReviewAgent,
  ReviewPromptContext,
  WorkItem,
} from "./blocks/delivery/index.ts";
import type {
  AgentFn,
  AgentOrHaltDeps,
  AgentSession,
  AgentStepConfig,
  AgentStepResult,
  AgentWire,
  AnswerReviewOptions,
  AnswerReviewPrompt,
  AnswerReviewPromptInput,
  AskStepConfig,
  AskWire,
  Attend,
  CheckForReply,
  ClaudeHarnessConfig,
  CodeReviewPrompt,
  CodeReviewPromptInput,
  CodexHarnessConfig,
  DescribePullRequestOptions,
  ExecuteAgentStep,
  ExecuteModelRequestStep,
  FixCiFreshPrompt,
  FixCiFreshPromptInput,
  FixCiOptions,
  FixCiPrompt,
  FixCiPromptInput,
  GateAck,
  GateCursor,
  GateFn,
  GateWake,
  Halt,
  HaltForHumanDeps,
  HaltForHumanFn,
  HaltOption,
  HaltQuestion,
  Handoff,
  HarnessConfig,
  HarnessName,
  HarnessOptions,
  HumanReply,
  ImplementOptions,
  ImplementPrompt,
  ImplementPromptInput,
  ImplementResult,
  JsonValue,
  McpHttpServer,
  McpProbe,
  McpServerConfig,
  McpStdioServer,
  PostComment,
  PostNote,
  PostReviewAnswersOptions,
  PrRef,
  PullRequestDescription,
  RebuildContextPrompt,
  RebuildContextPromptInput,
  ResumeOrRebuildOptions,
  ResumeOrRebuildResult,
  ReviewTicketOptions,
  SnapshotComment,
  StepResult,
  StepUsage,
  ThreadAnswers,
  TicketClaim,
  TicketLink,
  TicketNote,
  TicketRef,
  TicketReviewPrompt,
  TicketReviewPromptInput,
  TicketSnapshot,
  WireJsonSchema,
} from "./blocks/index.ts";
import type {
  ExecuteDeps,
  LinearIssueMatch,
  NeedsHumanContext,
  ProvisionWorktreeDeps,
  RenderNeedsHumanComment,
  RenderProceedingNote,
  TicketParticipants,
  WorktreeRequest,
} from "./steps/index.ts";

type BlocksTypeSurface = {
  agentFn: AgentFn;
  agentOrHaltDeps: AgentOrHaltDeps;
  agentSession: AgentSession;
  agentStepConfig: AgentStepConfig;
  agentStepResult: AgentStepResult;
  agentWire: AgentWire;
  answerReviewOptions: AnswerReviewOptions;
  answerReviewPrompt: AnswerReviewPrompt;
  answerReviewPromptInput: AnswerReviewPromptInput;
  askStepConfig: AskStepConfig;
  askWire: AskWire;
  attend: Attend<number>;
  checkForReply: CheckForReply;
  claudeHarnessConfig: ClaudeHarnessConfig;
  codeReviewPrompt: CodeReviewPrompt;
  codeReviewPromptInput: CodeReviewPromptInput;
  codexHarnessConfig: CodexHarnessConfig;
  describePrOptions: DescribePullRequestOptions;
  fixCiFreshPrompt: FixCiFreshPrompt;
  fixCiFreshPromptInput: FixCiFreshPromptInput;
  fixCiOptions: FixCiOptions;
  fixCiPrompt: FixCiPrompt;
  fixCiPromptInput: FixCiPromptInput;
  gateAck: GateAck;
  gateCursor: GateCursor;
  gateFn: GateFn;
  gateWake: GateWake;
  haltForHumanDeps: HaltForHumanDeps;
  haltForHumanFn: HaltForHumanFn;
  handoff: Handoff;
  harnessConfig: HarnessConfig;
  harnessName: HarnessName;
  halt: Halt;
  haltOption: HaltOption;
  haltQuestion: HaltQuestion;
  harnessOptions: HarnessOptions;
  humanReply: HumanReply;
  implementOptions: ImplementOptions;
  implementPrompt: ImplementPrompt;
  implementPromptInput: ImplementPromptInput;
  implementResult: ImplementResult;
  jsonValue: JsonValue;
  mcpHttpServer: McpHttpServer;
  mcpProbe: McpProbe;
  mcpServerConfig: McpServerConfig;
  mcpStdioServer: McpStdioServer;
  postComment: PostComment;
  postReviewAnswersOptions: PostReviewAnswersOptions;
  pullRequestDescription: PullRequestDescription;
  postNote: PostNote;
  prRef: PrRef;
  rebuildContextPrompt: RebuildContextPrompt;
  rebuildContextPromptInput: RebuildContextPromptInput;
  resumeOrRebuildOptions: ResumeOrRebuildOptions<undefined>;
  resumeOrRebuildResult: ResumeOrRebuildResult<undefined>;
  reviewTicketOptions: ReviewTicketOptions;
  executeAgentStep: ExecuteAgentStep;
  executeModelRequestStep: ExecuteModelRequestStep;
  snapshotComment: SnapshotComment;
  stepResult: StepResult;
  stepUsage: StepUsage;
  threadAnswers: ThreadAnswers;
  ticketClaim: TicketClaim;
  ticketLink: TicketLink;
  ticketNote: TicketNote;
  ticketRef: TicketRef;
  ticketReviewPrompt: TicketReviewPrompt;
  ticketReviewPromptInput: TicketReviewPromptInput;
  ticketSnapshot: TicketSnapshot;
  wireJsonSchema: WireJsonSchema;
};

type DeliveryTypeSurface = {
  approvedChange: ApprovedChange;
  ciRepairAgent: CiRepairAgent;
  ciRepairPromptContext: CiRepairPromptContext;
  deliverChangeOptions: DeliverChangeOptions;
  deliveryAgent: DeliveryAgent<ImplementationPromptContext>;
  deliveryAttempts: DeliveryAttempts;
  deliveryChange: DeliveryChange;
  deliveryLimits: DeliveryLimits;
  deliveryPhase: DeliveryPhase;
  deliveryResult: DeliveryResult;
  deliverySteps: DeliverySteps;
  deliveryStopped: DeliveryStopped;
  descriptionAgent: DescriptionAgent;
  descriptionPromptContext: DescriptionPromptContext;
  followPullRequestOptions: FollowPullRequestOptions;
  implementAndReviewOptions: ImplementAndReviewOptions;
  implementAndReviewResult: ImplementAndReviewResult;
  implementationAgent: ImplementationAgent;
  implementationPromptContext: ImplementationPromptContext;
  limitDecision: LimitDecision;
  limitReached: LimitReached;
  onDeliveryLimit: OnDeliveryLimit;
  publishApprovedChangeOptions: PublishApprovedChangeOptions;
  pullRequestRevisionAgent: PullRequestRevisionAgent;
  pullRequestRevisionPromptContext: PullRequestRevisionPromptContext;
  reviewAgent: ReviewAgent;
  reviewPromptContext: ReviewPromptContext;
  workItem: WorkItem;
};

type StepsTypeSurface = {
  executeDeps: ExecuteDeps;
  linearIssueMatch: LinearIssueMatch;
  needsHumanContext: NeedsHumanContext;
  provisionRunWorktreeDeps: ProvisionWorktreeDeps;
  renderNeedsHumanComment: RenderNeedsHumanComment;
  renderProceedingNote: RenderProceedingNote;
  ticketParticipants: TicketParticipants;
  worktreeRequest: WorktreeRequest;
};

test("every barrel still exports every type a factory names", () => {
  const surfaces: Array<BlocksTypeSurface | DeliveryTypeSurface | StepsTypeSurface | undefined> = [
    undefined,
    undefined,
    undefined,
  ];
  expect(surfaces).toHaveLength(3);
});
