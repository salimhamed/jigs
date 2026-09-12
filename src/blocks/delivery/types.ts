import type { CheckRun, PrRef, ReviewThread } from "../../providers/github.ts";
import type * as branch from "../../steps/pull-request/branch.ts";
import type * as pr from "../../steps/pull-request/pr.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { PullRequestDescription } from "../builder-agent/describe-pr.ts";
import type { GateAck, GateWake } from "../pull-request/gate.ts";
import type { WorktreeFacts } from "../worktree.ts";

/** The requirements to deliver, independent of where they were recorded. */
export interface WorkItem {
  key: string;
  title: string;
  instructions: string;
  url?: string;
}

export type DeliveryPhase = "implementation-review" | "ci-repair" | "pull-request-revision";
export type AgentRoleName = "implementation" | "review" | "ciRepair" | "pullRequestRevision";
export interface DeliveryPromptContext {
  task: WorkItem;
  worktree: WorktreeFacts;
  phase: DeliveryPhase | "pull-request-description" | "commit";
  attempt: number;
  findings: string[];
  instructions: string;
  diff?: string;
  threads?: ReviewThread[];
  reviewBody?: string;
  failing?: CheckRun[];
}

export interface DeliveryAgent {
  harness: HarnessConfig;
  prompt?: (context: DeliveryPromptContext) => string;
}
export interface DescriptionAgent extends DeliveryAgent {
  transform?: (description: PullRequestDescription, task: WorkItem) => PullRequestDescription;
}

/** Counts agent attempts across the entire delivery, including later CI failures. */
export interface DeliveryLimits {
  implementationReviewRounds: number;
  ciFixAttempts: number;
  pullRequestRevisionRounds: number;
}
export interface DeliveryLimit {
  phase: DeliveryPhase;
  attempts: number;
  findings: string[];
  task: WorkItem;
  worktree: WorktreeFacts;
  pr?: PrRef;
}
export type LimitDecision =
  | { action: "continue"; instructions: string; additionalAttempts: number }
  | { action: "stop" };
export type OnDeliveryLimit = (limit: DeliveryLimit) => Promise<LimitDecision>;

/** The work performed so far. Use onLimit to continue within the same durable run. */
export interface DeliveryChange {
  task: WorkItem;
  worktree: WorktreeFacts;
  attempts: DeliveryLimits;
  sessions: Partial<Record<AgentRoleName, { harness: HarnessConfig; session: AgentSession }>>;
}
export interface DeliveryStopped {
  status: "limit-reached" | "stopped";
  phase: DeliveryPhase;
  attempts: number;
  findings: string[];
  change: DeliveryChange;
  pr?: PrRef;
}
export type ImplementResult = { status: "approved"; change: DeliveryChange } | DeliveryStopped;
export type DeliveryResult =
  | { status: "merged" | "closed"; change: DeliveryChange; pr: PrRef }
  | DeliveryStopped;

export interface ImplementOptions {
  task: WorkItem;
  worktree: WorktreeFacts;
  implementation: DeliveryAgent;
  review: DeliveryAgent;
  maxRounds: number;
  onLimit?: OnDeliveryLimit;
}
export interface OpenPullRequestOptions {
  change: DeliveryChange;
  binding: string;
  implementation: DeliveryAgent;
  pullRequestDescription?: DescriptionAgent;
}
export interface FollowPullRequestOptions {
  change: DeliveryChange;
  pr: PrRef;
  implementation: DeliveryAgent;
  ciRepair?: DeliveryAgent;
  pullRequestRevision?: DeliveryAgent;
  limits: Pick<DeliveryLimits, "ciFixAttempts" | "pullRequestRevisionRounds">;
  merge: "human" | "jigs";
  onLimit?: OnDeliveryLimit;
}
export interface ReviewLoopOptions extends Omit<ImplementOptions, "maxRounds"> {
  binding: string;
  ciRepair?: DeliveryAgent;
  pullRequestRevision?: DeliveryAgent;
  pullRequestDescription?: DescriptionAgent;
  limits: DeliveryLimits;
  merge: "human" | "jigs";
}

/** Supply the factory's durable functions once, then use the delivery operations. */
export interface DeliverySteps {
  agent: AgentFn;
  pullRequestGate: (pr: PrRef) => AsyncGenerator<GateWake, void, GateAck | undefined>;
  readBranchState: typeof branch.readBranchState;
  readWorktreeDiff: typeof branch.readWorktreeDiff;
  pushBranch: typeof branch.pushBranch;
  resolveRepository: typeof pr.resolveRepository;
  createPullRequest: typeof pr.openPullRequest;
  commentOnPullRequest: typeof pr.commentOnPullRequest;
  replyToPullRequestReviewThread: typeof pr.replyToPullRequestReviewThread;
  squashMergePullRequest: typeof pr.squashMergePullRequest;
}
