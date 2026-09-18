// The type half of what the barrels export. package.test.ts asserts the value
// names with a runtime import, which cannot see a type at all: a `TicketRef` or
// a `JsonValue` dropped from blocks/index.ts would pass every test in this repo
// and break a factory on install. Here the guard is tsc —
// `pnpm typecheck` fails when one of these names stops being exported.

import { expect, test } from "vitest";
import type {
  AgentFn,
  AgentOrHaltDeps,
  AgentSession,
  AgentStepConfig,
  AgentStepResult,
  AgentWire,
  AskStepConfig,
  AskWire,
  Attend,
  CheckForTicketHumanReply,
  ClaudeHarnessConfig,
  ClaudeHarnessOptions,
  CodexHarnessConfig,
  CodexHarnessOptions,
  ExecuteAgentStep,
  ExecuteModelRequestStep,
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
  JsonValue,
  MarkerKind,
  MarkerLedger,
  McpHttpServer,
  McpProbe,
  McpServerConfig,
  McpStdioServer,
  MergeRefusal,
  PostPullRequestNoteOptions,
  PostReviewAnswersOptions,
  PostTicketHumanInputRequest,
  PostTicketNote,
  PrMarker,
  PrRef,
  PrState,
  RebuildContextPrompt,
  RebuildContextPromptInput,
  ResumeOrRebuildOptions,
  ResumeOrRebuildResult,
  ReviewTicketOptions,
  SnapshotComment,
  StatusReason,
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
  RenderTicketNote,
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
  askStepConfig: AskStepConfig;
  askWire: AskWire;
  attend: Attend<number>;
  checkForTicketHumanReply: CheckForTicketHumanReply;
  claudeHarnessConfig: ClaudeHarnessConfig;
  codexHarnessConfig: CodexHarnessConfig;
  codexHarnessOptions: CodexHarnessOptions;
  gateFn: GateFn;
  gateWake: GateWake;
  markerKind: MarkerKind;
  markerLedger: MarkerLedger;
  mergeRefusal: MergeRefusal;
  prMarker: PrMarker;
  prState: PrState;
  statusReason: StatusReason;
  haltForHumanDeps: HaltForHumanDeps;
  haltForHumanFn: HaltForHumanFn;
  handoff: Handoff;
  harnessConfig: HarnessConfig;
  harnessName: HarnessName;
  halt: Halt;
  haltOption: HaltOption;
  haltQuestion: HaltQuestion;
  harnessOptions: HarnessOptions;
  claudeHarnessOptions: ClaudeHarnessOptions;
  humanReply: HumanReply;
  jsonValue: JsonValue;
  mcpHttpServer: McpHttpServer;
  mcpProbe: McpProbe;
  mcpServerConfig: McpServerConfig;
  mcpStdioServer: McpStdioServer;
  postTicketHumanInputRequest: PostTicketHumanInputRequest;
  postPullRequestNoteOptions: PostPullRequestNoteOptions;
  postReviewAnswersOptions: PostReviewAnswersOptions;
  postTicketNote: PostTicketNote;
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

type StepsTypeSurface = {
  executeDeps: ExecuteDeps;
  linearIssueMatch: LinearIssueMatch;
  needsHumanContext: NeedsHumanContext;
  provisionRunWorktreeDeps: ProvisionWorktreeDeps;
  renderNeedsHumanComment: RenderNeedsHumanComment;
  renderTicketNote: RenderTicketNote;
  ticketParticipants: TicketParticipants;
  worktreeRequest: WorktreeRequest;
};

test("every barrel still exports every type a factory names", () => {
  const surfaces: Array<BlocksTypeSurface | StepsTypeSurface | undefined> = [undefined, undefined];
  expect(surfaces).toHaveLength(2);
});
