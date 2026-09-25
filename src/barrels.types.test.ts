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
  ApprovalState,
  AskAgentOptions,
  AskModelOptions,
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
  FileChange,
  Halt,
  HaltOption,
  HaltQuestion,
  Harness,
  HarnessKind,
  HumanReply,
  JsonValue,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpToolProbe,
  ModelKind,
  ModelRequest,
  ModelResult,
  ModelSource,
  OutputJsonSchema,
  PiMcpHttpServerConfig,
  PiMcpServerConfig,
  PiMcpStdioServerConfig,
  PullRequestApproval,
  PullRequestMarker,
  PullRequestRef,
  RebuildContextPrompt,
  RebuildContextPromptInput,
  ReleasePolicy,
  ReleaseReport,
  ReviewThread,
  RunAgentOptions,
  RunResource,
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
import type { ProvisionWorktreeDependencies, WorktreeRequest } from "./steps/workspaces/index.ts";

type RootTypeSurface = {
  agentRequest: AgentRequest;
  agentResult: AgentResult;
  agentSessionRef: AgentSessionRef;
  askAgentOptions: AskAgentOptions;
  askModelOptions: AskModelOptions;
  changePatch: ChangePatch;
  changeStatus: ChangeStatus;
  changeSummary: ChangeSummary;
  checkRun: CheckRun;
  approvalState: ApprovalState;
  claudeHarness: ClaudeHarness;
  claudeHarnessSettings: ClaudeHarnessSettings;
  claudePolicyKey: ClaudePolicyKey;
  codexHarness: CodexHarness;
  codexHarnessSettings: CodexHarnessSettings;
  codexPolicyKey: CodexPolicyKey;
  fileChange: FileChange;
  halt: Halt;
  haltOption: HaltOption;
  haltQuestion: HaltQuestion;
  harness: Harness;
  harnessKind: HarnessKind;
  humanReply: HumanReply;
  jsonValue: JsonValue;
  mcpHttpServer: McpHttpServerConfig;
  mcpServer: McpServerConfig;
  mcpStdioServer: McpStdioServerConfig;
  mcpProbe: McpToolProbe;
  modelKind: ModelKind;
  modelRequest: ModelRequest;
  modelResult: ModelResult;
  modelSource: ModelSource;
  outputJsonSchema: OutputJsonSchema;
  piMcpHttpServer: PiMcpHttpServerConfig;
  piMcpServer: PiMcpServerConfig;
  piMcpStdioServer: PiMcpStdioServerConfig;
  prApproval: PullRequestApproval;
  prMarker: PullRequestMarker;
  prRef: PullRequestRef;
  rebuildContextPrompt: RebuildContextPrompt;
  rebuildContextPromptInput: RebuildContextPromptInput;
  releasePolicy: ReleasePolicy;
  releaseReport: ReleaseReport;
  reviewThread: ReviewThread;
  runAgentOptions: RunAgentOptions;
  runResource: RunResource;
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
  worktree: Worktree;
};

type StepsTypeSurface = {
  agentRunner: AgentRunner;
  agentRunnerOptions: AgentRunnerOptions;
  mergeOutcome: MergeOutcome;
  openedPullRequest: OpenedPullRequest;
  linearIssueMatch: LinearIssueMatch;
  needsHumanContext: NeedsHumanContext;
  provisionRunWorktreeDeps: ProvisionWorktreeDependencies;
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
