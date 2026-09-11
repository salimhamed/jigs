// The type half of what the two barrels export. package.test.ts asserts the
// value names with a runtime import, which cannot see a type at all: a
// `TicketRef` or a `JsonValue` dropped from blocks/index.ts would pass every
// test in this repo and break a factory on install. Here the guard is tsc —
// `pnpm typecheck` fails when one of these names stops being exported.

import { expect, test } from "vitest";
import type {
  AgentFn,
  AgentOrHaltDeps,
  AgentSession,
  AgentStepConfig,
  AgentStepResult,
  AgentWire,
  AnswerReviewOptions,
  AskStepConfig,
  AskWire,
  Attend,
  CheckForHumanReply,
  ClaudeHarnessConfig,
  CodexHarnessConfig,
  CommitWorkOptions,
  DescribePrOptions,
  FixCiOptions,
  GateAck,
  GateCursor,
  GateFn,
  GateWake,
  HaltForHumanDeps,
  HaltForHumanFn,
  Handoff,
  HarnessConfig,
  HarnessOptions,
  HumanReply,
  ImplementOptions,
  ImplementResult,
  JsonValue,
  McpHttpServer,
  McpProbe,
  McpServerConfig,
  McpStdioServer,
  PostNeedsHumanComment,
  PostReviewAnswersOptions,
  PrDescription,
  Prompt,
  PromptRef,
  PrRef,
  ResumeOrRebuildOptions,
  ResumeOrRebuildResult,
  ReviewTicketOptions,
  RunAgentStep,
  RunAskStep,
  SnapshotComment,
  StepResult,
  StepUsage,
  ThreadAnswers,
  TicketClaim,
  TicketLink,
  TicketRef,
  TicketSnapshot,
  WireJsonSchema,
} from "./blocks/index.ts";
import type {
  ExecuteDeps,
  LinearIssueMatch,
  PromptCheckFailure,
  PromptData,
  PromptRegistry,
  PromptRegistryOptions,
  PromptSource,
  ProvisionRunWorktreeDeps,
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
  askStepConfig: AskStepConfig;
  askWire: AskWire;
  attend: Attend<number>;
  checkForHumanReply: CheckForHumanReply;
  claudeHarnessConfig: ClaudeHarnessConfig;
  codexHarnessConfig: CodexHarnessConfig;
  commitWorkOptions: CommitWorkOptions;
  describePrOptions: DescribePrOptions;
  fixCiOptions: FixCiOptions;
  gateAck: GateAck;
  gateCursor: GateCursor;
  gateFn: GateFn;
  gateWake: GateWake;
  haltForHumanDeps: HaltForHumanDeps;
  haltForHumanFn: HaltForHumanFn;
  handoff: Handoff;
  harnessConfig: HarnessConfig;
  harnessOptions: HarnessOptions;
  humanReply: HumanReply;
  implementOptions: ImplementOptions;
  implementResult: ImplementResult;
  jsonValue: JsonValue;
  mcpHttpServer: McpHttpServer;
  mcpProbe: McpProbe;
  mcpServerConfig: McpServerConfig;
  mcpStdioServer: McpStdioServer;
  postNeedsHumanComment: PostNeedsHumanComment;
  postReviewAnswersOptions: PostReviewAnswersOptions;
  prDescription: PrDescription;
  prompt: Prompt;
  promptRef: PromptRef;
  prRef: PrRef;
  resumeOrRebuildOptions: ResumeOrRebuildOptions<undefined>;
  resumeOrRebuildResult: ResumeOrRebuildResult<undefined>;
  reviewTicketOptions: ReviewTicketOptions;
  runAgentStep: RunAgentStep;
  runAskStep: RunAskStep;
  snapshotComment: SnapshotComment;
  stepResult: StepResult;
  stepUsage: StepUsage;
  threadAnswers: ThreadAnswers;
  ticketClaim: TicketClaim;
  ticketLink: TicketLink;
  ticketRef: TicketRef;
  ticketSnapshot: TicketSnapshot;
  wireJsonSchema: WireJsonSchema;
};

type StepsTypeSurface = {
  executeDeps: ExecuteDeps;
  linearIssueMatch: LinearIssueMatch;
  promptCheckFailure: PromptCheckFailure;
  promptData: PromptData;
  promptRegistry: PromptRegistry;
  promptRegistryOptions: PromptRegistryOptions;
  promptSource: PromptSource;
  provisionRunWorktreeDeps: ProvisionRunWorktreeDeps;
  worktreeRequest: WorktreeRequest;
};

test("both barrels still export every type a factory names", () => {
  const surfaces: Array<BlocksTypeSurface | StepsTypeSurface | undefined> = [
    undefined,
    undefined,
  ];
  expect(surfaces).toHaveLength(2);
});
