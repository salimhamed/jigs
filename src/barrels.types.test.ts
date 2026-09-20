// The type half of what the barrels export. package.test.ts asserts the value
// names with a runtime import, which cannot see a type at all: a `TicketRef` or
// a `JsonValue` dropped from a topic index would pass every test in this repo
// and break a factory on install. Here the guard is tsc —
// `pnpm typecheck` fails when one of these names stops being exported.

import { expect, test } from "vitest";
import type {
  AgentRequest,
  AgentResult,
  AgentSession,
  AskModelOptions,
  ClaudeHarnessConfig,
  ClaudeHarnessOptions,
  CodexHarnessConfig,
  CodexHarnessOptions,
  ExecuteAgentStep,
  ExecuteModelStep,
  HarnessConfig,
  HarnessKind,
  HarnessOptions,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpToolProbe,
  ModelRequest,
  ModelResult,
  ModelUsage,
  OutputJsonSchema,
  RebuildContextPrompt,
  RebuildContextPromptInput,
  ResumeOrRebuildOptions,
  ResumeOrRebuildResult,
  RunAgentFn,
  RunAgentOptions,
  RunAgentOrHaltDependencies,
} from "./blocks/agents/index.ts";
import type { ChangePatch, ChangeStatus, ChangeSummary, FileChange } from "./blocks/git/index.ts";
import type { HaltOption, HaltQuestion, JsonValue } from "./blocks/human/index.ts";
import type {
  CheckForTicketHumanReply,
  Halt,
  HaltForHumanDependencies,
  HaltForHumanFn,
  HumanReply,
  PostTicketHumanInputRequest,
  PostTicketNote,
  ReviewTicketOptions,
  TicketClaim,
  TicketComment,
  TicketHandoff,
  TicketLink,
  TicketNote,
  TicketRef,
  TicketReviewPrompt,
  TicketReviewPromptInput,
  TicketSnapshot,
} from "./blocks/linear/index.ts";
import type {
  Attend,
  MarkerKind,
  MarkerLedger,
  MergeRefusal,
  PostPullRequestNoteOptions,
  PostReviewAnswersOptions,
  PullRequestGateFn,
  PullRequestMarker,
  PullRequestRef,
  PullRequestState,
  PullRequestWake,
  StatusReason,
  ThreadAnswers,
} from "./blocks/pull-requests/index.ts";
import type { ReleasePolicy, ReleaseReport, ReleaseSteps } from "./blocks/runtime/index.ts";
import type { Worktree } from "./blocks/workspaces/index.ts";
import type { AgentExecutionDependencies } from "./steps/agents/index.ts";
import type {
  LinearIssueMatch,
  NeedsHumanContext,
  RenderNeedsHumanComment,
  RenderTicketNote,
  TicketParticipants,
  TicketStatusResult,
} from "./steps/linear/index.ts";
import type {
  GitHubRepoRef,
  MergeOutcome,
  OpenedPullRequest,
} from "./steps/pull-requests/index.ts";
import type { ProvisionWorktreeDependencies, WorktreeRequest } from "./steps/workspaces/index.ts";

type BlocksTypeSurface = {
  changePatch: ChangePatch;
  changeStatus: ChangeStatus;
  changeSummary: ChangeSummary;
  fileChange: FileChange;
  releasePolicy: ReleasePolicy;
  releaseReport: ReleaseReport;
  releaseSteps: ReleaseSteps;
  worktreeFacts: Worktree;
  agentFn: RunAgentFn;
  agentOrHaltDeps: RunAgentOrHaltDependencies;
  agentSession: AgentSession;
  agentStepConfig: RunAgentOptions;
  agentStepResult: AgentResult;
  agentWire: AgentRequest;
  askStepConfig: AskModelOptions;
  askWire: ModelRequest;
  attend: Attend<number>;
  checkForTicketHumanReply: CheckForTicketHumanReply;
  claudeHarnessConfig: ClaudeHarnessConfig;
  codexHarnessConfig: CodexHarnessConfig;
  codexHarnessOptions: CodexHarnessOptions;
  gateFn: PullRequestGateFn;
  gateWake: PullRequestWake;
  markerKind: MarkerKind;
  markerLedger: MarkerLedger;
  mergeRefusal: MergeRefusal;
  prMarker: PullRequestMarker;
  prState: PullRequestState;
  statusReason: StatusReason;
  haltForHumanDeps: HaltForHumanDependencies;
  haltForHumanFn: HaltForHumanFn;
  handoff: TicketHandoff;
  harnessConfig: HarnessConfig;
  harnessName: HarnessKind;
  halt: Halt;
  haltOptionSchema: HaltOption;
  haltQuestionSchema: HaltQuestion;
  harnessOptions: HarnessOptions;
  claudeHarnessOptions: ClaudeHarnessOptions;
  humanReply: HumanReply;
  jsonValue: JsonValue;
  mcpHttpServer: McpHttpServerConfig;
  mcpProbe: McpToolProbe;
  mcpServerConfig: McpServerConfig;
  mcpStdioServer: McpStdioServerConfig;
  postTicketHumanInputRequest: PostTicketHumanInputRequest;
  postPullRequestNoteOptions: PostPullRequestNoteOptions;
  postReviewAnswersOptions: PostReviewAnswersOptions;
  postTicketNote: PostTicketNote;
  prRef: PullRequestRef;
  rebuildContextPrompt: RebuildContextPrompt;
  rebuildContextPromptInput: RebuildContextPromptInput;
  resumeOrRebuildOptions: ResumeOrRebuildOptions<undefined>;
  resumeOrRebuildResult: ResumeOrRebuildResult<undefined>;
  reviewTicketOptions: ReviewTicketOptions;
  executeAgentStep: ExecuteAgentStep;
  executeModelRequestStep: ExecuteModelStep;
  snapshotComment: TicketComment;
  stepResult: ModelResult;
  stepUsage: ModelUsage;
  threadAnswers: ThreadAnswers;
  ticketClaim: TicketClaim;
  ticketLink: TicketLink;
  ticketNote: TicketNote;
  ticketRef: TicketRef;
  ticketReviewPrompt: TicketReviewPrompt;
  ticketReviewPromptInput: TicketReviewPromptInput;
  ticketSnapshot: TicketSnapshot;
  wireJsonSchema: OutputJsonSchema;
};

type StepsTypeSurface = {
  githubRepoRef: GitHubRepoRef;
  mergeOutcome: MergeOutcome;
  openedPullRequest: OpenedPullRequest;
  executeDeps: AgentExecutionDependencies;
  linearIssueMatch: LinearIssueMatch;
  needsHumanContext: NeedsHumanContext;
  provisionRunWorktreeDeps: ProvisionWorktreeDependencies;
  renderNeedsHumanComment: RenderNeedsHumanComment;
  renderTicketNote: RenderTicketNote;
  ticketParticipants: TicketParticipants;
  ticketStatusResult: TicketStatusResult;
  worktreeRequest: WorktreeRequest;
};

test("every barrel still exports every type a factory names", () => {
  const surfaces: Array<BlocksTypeSurface | StepsTypeSurface | undefined> = [undefined, undefined];
  expect(surfaces).toHaveLength(2);
});
