// The type half of what the barrels export. package.test.ts asserts the value
// names with a runtime import, which cannot see a type at all: a `TicketRef` or
// a `JsonValue` dropped from a topic index would pass every test in this repo
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
  ClaudeHarnessConfig,
  ClaudeHarnessOptions,
  CodexHarnessConfig,
  CodexHarnessOptions,
  ExecuteAgentStep,
  ExecuteModelRequestStep,
  HarnessConfig,
  HarnessName,
  HarnessOptions,
  McpHttpServer,
  McpProbe,
  McpServerConfig,
  McpStdioServer,
  RebuildContextPrompt,
  RebuildContextPromptInput,
  ResumeOrRebuildOptions,
  ResumeOrRebuildResult,
  StepResult,
  StepUsage,
  WireJsonSchema,
} from "./blocks/agents/index.ts";
import type { ChangePatch, ChangeStatus, ChangeSummary, FileChange } from "./blocks/git/index.ts";
import type { HaltOption, HaltQuestion, JsonValue } from "./blocks/human/index.ts";
import type {
  CheckForTicketHumanReply,
  Halt,
  HaltForHumanDeps,
  HaltForHumanFn,
  Handoff,
  HumanReply,
  PostTicketHumanInputRequest,
  PostTicketNote,
  ReviewTicketOptions,
  SnapshotComment,
  TicketClaim,
  TicketLink,
  TicketNote,
  TicketRef,
  TicketReviewPrompt,
  TicketReviewPromptInput,
  TicketSnapshot,
} from "./blocks/linear/index.ts";
import type {
  Attend,
  GateFn,
  GateWake,
  MarkerKind,
  MarkerLedger,
  MergeRefusal,
  PostPullRequestNoteOptions,
  PostReviewAnswersOptions,
  PrMarker,
  PrRef,
  PrState,
  StatusReason,
  ThreadAnswers,
} from "./blocks/pull-requests/index.ts";
import type { ReleasePolicy, ReleaseReport, ReleaseSteps } from "./blocks/runtime/index.ts";
import type { WorktreeFacts } from "./blocks/workspaces/index.ts";
import type { ExecuteDeps } from "./steps/agents/index.ts";
import type {
  LinearIssueMatch,
  NeedsHumanContext,
  RenderNeedsHumanComment,
  RenderTicketNote,
  TicketParticipants,
} from "./steps/linear/index.ts";
import type {
  GithubRepoRef,
  MergeOutcome,
  OpenedPullRequest,
} from "./steps/pull-requests/index.ts";
import type { ProvisionWorktreeDeps, WorktreeRequest } from "./steps/workspaces/index.ts";

type BlocksTypeSurface = {
  changePatch: ChangePatch;
  changeStatus: ChangeStatus;
  changeSummary: ChangeSummary;
  fileChange: FileChange;
  releasePolicy: ReleasePolicy;
  releaseReport: ReleaseReport;
  releaseSteps: ReleaseSteps;
  worktreeFacts: WorktreeFacts;
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
  githubRepoRef: GithubRepoRef;
  mergeOutcome: MergeOutcome;
  openedPullRequest: OpenedPullRequest;
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
