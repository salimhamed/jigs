// The type half of what the entry points export. package.test.ts asserts the value
// names with a runtime import, which cannot see a type at all: a `TicketRef` or
// a `JsonValue` dropped from the root would pass every test in this repo
// and break a factory on install. Here the guard is tsc —
// `pnpm typecheck` fails when one of these names stops being exported.

import { expect, test } from "vitest";
import type {
  AgentRequest,
  AgentResult,
  AgentSessionRef,
  ApprovalCoverage,
  ApprovalState,
  AskAgentOptions,
  AskModelOptions,
  BuildFacts,
  BuildStopped,
  Built,
  ChangePatch,
  ChangeStatus,
  ChangeSummary,
  CheckRun,
  ClaudeHarness,
  ClaudeHarnessSettings,
  ClaudePolicyKey,
  CodexHarness,
  CodexHarnessSettings,
  CodexPolicyKey,
  Delivery,
  DeliveryPrompts,
  FileChange,
  FindingResponse,
  Halt,
  HaltOption,
  HaltQuestion,
  Harness,
  HarnessKind,
  HumanReply,
  IncidentRef,
  IncidentSnapshot,
  JsonValue,
  MaintainFacts,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpToolProbe,
  MergeBlocked,
  ModelKind,
  ModelRequest,
  ModelResult,
  ModelSource,
  NeedsHuman,
  OutputJsonSchema,
  PiMcpHttpServerConfig,
  PiMcpServerConfig,
  PiMcpStdioServerConfig,
  PullRequestApproval,
  PullRequestMarker,
  PullRequestReadOptions,
  PullRequestRef,
  RebuildContextPrompt,
  RebuildContextPromptInput,
  ReleasePolicy,
  ReleaseReport,
  ReviewFacts,
  ReviewFinding,
  ReviewRound,
  ReviewThread,
  RunAgentOptions,
  RunResource,
  SlackAuthor,
  SlackMessageSnapshot,
  SlackPost,
  SlackQuestion,
  StatusReason,
  ThreadAnswers,
  TicketClaim,
  TicketComment,
  TicketHandoff,
  TicketLink,
  TicketNote,
  TicketRef,
  TicketReviewPrompt,
  TicketReviewPromptInput,
  TicketSnapshot,
  UnpublishedWork,
  Worktree,
} from "./index.ts";
import type { AgentRunner, AgentRunnerOptions } from "./steps/index.ts";
import type {
  LinearIssueMatch,
  NeedsHumanContext,
  RenderNeedsHumanComment,
  RenderTicketNote,
  TicketParticipants,
  TicketStatusResult,
} from "./steps/linear/index.ts";
import type { MergeOutcome, OpenedPullRequest } from "./steps/pull-requests/index.ts";
import type { WorktreeRequest } from "./steps/workspaces/index.ts";

type RootTypeSurface = {
  agentRequest: AgentRequest;
  agentResult: AgentResult;
  agentSessionRef: AgentSessionRef;
  askAgentOptions: AskAgentOptions;
  askModelOptions: AskModelOptions;
  buildFacts: BuildFacts<unknown>;
  buildStopped: BuildStopped;
  built: Built;
  changePatch: ChangePatch;
  changeStatus: ChangeStatus;
  changeSummary: ChangeSummary;
  checkRun: CheckRun;
  approvalCoverage: ApprovalCoverage;
  approvalState: ApprovalState;
  claudeHarness: ClaudeHarness;
  claudeHarnessSettings: ClaudeHarnessSettings;
  claudePolicyKey: ClaudePolicyKey;
  codexHarness: CodexHarness;
  codexHarnessSettings: CodexHarnessSettings;
  codexPolicyKey: CodexPolicyKey;
  delivery: Delivery<unknown>;
  deliveryPrompts: DeliveryPrompts<unknown>;
  fileChange: FileChange;
  findingResponse: FindingResponse;
  halt: Halt;
  haltOption: HaltOption;
  haltQuestion: HaltQuestion;
  harness: Harness;
  harnessKind: HarnessKind;
  humanReply: HumanReply;
  incidentRef: IncidentRef;
  incidentSnapshot: IncidentSnapshot;
  jsonValue: JsonValue;
  maintainFacts: MaintainFacts;
  mcpHttpServer: McpHttpServerConfig;
  mcpServer: McpServerConfig;
  mcpStdioServer: McpStdioServerConfig;
  mcpProbe: McpToolProbe;
  mergeBlocked: MergeBlocked;
  modelKind: ModelKind;
  modelRequest: ModelRequest;
  modelResult: ModelResult;
  modelSource: ModelSource;
  needsHuman: NeedsHuman;
  outputJsonSchema: OutputJsonSchema;
  piMcpHttpServer: PiMcpHttpServerConfig;
  piMcpServer: PiMcpServerConfig;
  piMcpStdioServer: PiMcpStdioServerConfig;
  prApproval: PullRequestApproval;
  prMarker: PullRequestMarker;
  prReadOptions: PullRequestReadOptions;
  prRef: PullRequestRef;
  rebuildContextPrompt: RebuildContextPrompt;
  rebuildContextPromptInput: RebuildContextPromptInput;
  releasePolicy: ReleasePolicy;
  releaseReport: ReleaseReport;
  reviewFacts: ReviewFacts<unknown>;
  reviewFinding: ReviewFinding;
  reviewRound: ReviewRound;
  reviewThread: ReviewThread;
  runAgentOptions: RunAgentOptions;
  runResource: RunResource;
  slackAuthor: SlackAuthor;
  slackMessageSnapshot: SlackMessageSnapshot;
  slackPost: SlackPost;
  slackQuestion: SlackQuestion;
  statusReason: StatusReason;
  threadAnswers: ThreadAnswers;
  ticketClaim: TicketClaim;
  ticketComment: TicketComment;
  ticketHandoff: TicketHandoff;
  ticketLink: TicketLink;
  ticketNote: TicketNote;
  ticketRef: TicketRef;
  ticketReviewPrompt: TicketReviewPrompt;
  ticketReviewPromptInput: TicketReviewPromptInput;
  ticketSnapshot: TicketSnapshot;
  unpublishedWork: UnpublishedWork;
  worktree: Worktree;
};

type StepsTypeSurface = {
  agentRunner: AgentRunner;
  agentRunnerOptions: AgentRunnerOptions;
  mergeOutcome: MergeOutcome;
  openedPullRequest: OpenedPullRequest;
  linearIssueMatch: LinearIssueMatch;
  needsHumanContext: NeedsHumanContext;
  renderNeedsHumanComment: RenderNeedsHumanComment;
  renderTicketNote: RenderTicketNote;
  ticketParticipants: TicketParticipants;
  ticketStatusResult: TicketStatusResult;
  worktreeRequest: WorktreeRequest;
};

test("the root and the step entries still export every type a factory names", () => {
  const surfaces: Array<RootTypeSurface | StepsTypeSurface | undefined> = [undefined, undefined];
  expect(surfaces).toHaveLength(2);
});
