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

/**
 * What every role is told, whatever its job: the work item as the factory
 * wrote it, the worktree it is checked out in, which attempt of its phase this
 * is, and the prompt jigs would have sent if the role had no callback.
 */
interface RolePromptContext<TTask extends WorkItem> {
  task: TTask;
  worktree: WorktreeFacts;
  /** Counts attempts of this role's phase; 1 on the first one. */
  attempt: number;
  /**
   * Renders the shipped default prompt for this attempt. Await it and add to
   * the result to extend the default; ignore it and return a string of your
   * own to replace the default entirely. Either is a first-class use.
   */
  renderDefaultPrompt: () => Promise<string>;
}

/** Write the change and commit it. */
export interface ImplementationPromptContext<TTask extends WorkItem = WorkItem>
  extends RolePromptContext<TTask> {
  /** The previous round's review findings; empty on the first round. */
  findings: string[];
  /** Direction an `onLimit` continuation supplied; empty until a limit is extended. */
  instructions: string;
  /**
   * Only on the fresh-session rebuild arm, where the agent holds no memory of
   * the work. A resumed agent already has it and is never charged a diff read.
   */
  diff?: string;
}

/**
 * Judge the committed work. Runs fresh every round against the committed diff,
 * which is why it is never told the previous round's `findings`: the verdict is
 * a new reading of the code, not a re-scoring of what the last review said.
 */
export interface ReviewPromptContext<TTask extends WorkItem = WorkItem>
  extends RolePromptContext<TTask> {
  baseCommit: string;
  /** The commit being reviewed, and the only one publication will accept. */
  headCommit: string;
  diff: string;
  /** Direction an `onLimit` continuation supplied; empty until a limit is extended. */
  instructions: string;
}

/** Repair the pull request's failing checks. */
export interface CiRepairPromptContext<TTask extends WorkItem = WorkItem>
  extends RolePromptContext<TTask> {
  failing: CheckRun[];
  pr: PrRef;
  /** Direction an `onLimit` continuation supplied; empty until a limit is extended. */
  instructions: string;
  /** Only on the fresh-session rebuild arm, where the agent holds no memory of the work. */
  diff?: string;
}

/** Answer the pull request's review feedback. */
export interface PullRequestRevisionPromptContext<TTask extends WorkItem = WorkItem>
  extends RolePromptContext<TTask> {
  /** Empty when a review requested changes without leaving line comments. */
  threads: ReviewThread[];
  /** The summary of the review that requested changes, when it had one. */
  reviewBody?: string;
  pr: PrRef;
  /** Direction an `onLimit` continuation supplied; empty until a limit is extended. */
  instructions: string;
  /** Only on the fresh-session rebuild arm, where the agent holds no memory of the work. */
  diff?: string;
}

/** Describe the approved change. Runs once, against the commit about to be published. */
export interface DescriptionPromptContext<TTask extends WorkItem = WorkItem> {
  task: TTask;
  worktree: WorktreeFacts;
  diff: string;
  /**
   * Renders the shipped default prompt. Await it and add to the result to
   * extend the default; ignore it and return a string of your own to replace
   * the default entirely. Either is a first-class use.
   */
  renderDefaultPrompt: () => Promise<string>;
}

/** A harness, and optionally the prompt its role is given instead of the default. */
export interface DeliveryAgent<TContext> {
  harness: HarnessConfig;
  prompt?: (context: TContext) => string | Promise<string>;
}
export type ImplementationAgent<TTask extends WorkItem = WorkItem> = DeliveryAgent<
  ImplementationPromptContext<TTask>
>;
export type ReviewAgent<TTask extends WorkItem = WorkItem> = DeliveryAgent<
  ReviewPromptContext<TTask>
>;
export type CiRepairAgent<TTask extends WorkItem = WorkItem> = DeliveryAgent<
  CiRepairPromptContext<TTask>
>;
export type PullRequestRevisionAgent<TTask extends WorkItem = WorkItem> = DeliveryAgent<
  PullRequestRevisionPromptContext<TTask>
>;
export interface DescriptionAgent<TTask extends WorkItem = WorkItem>
  extends DeliveryAgent<DescriptionPromptContext<TTask>> {
  transform?: (description: PullRequestDescription, task: TTask) => PullRequestDescription;
}

/** The budgets a delivery runs under. Each phase counts cumulatively and alone. */
export interface DeliveryLimits {
  /** One round is one implementation attempt plus one review of what it committed. */
  implementationReviewRounds: number;
  /** Repair attempts against failing checks, over the pull request's whole life. */
  ciFixAttempts: number;
  /** Rounds spent answering pull-request review feedback; one batch of threads is one round. */
  pullRequestRevisionRounds: number;
}

/** What a delivery has spent, counted under the same names as its budgets. */
export interface DeliveryAttempts {
  implementationReviewRounds: number;
  ciFixAttempts: number;
  pullRequestRevisionRounds: number;
}
export interface DeliveryLimit<TTask extends WorkItem = WorkItem> {
  phase: DeliveryPhase;
  attempts: number;
  findings: string[];
  task: TTask;
  worktree: WorktreeFacts;
  pr?: PrRef;
}
export type LimitDecision =
  | { action: "continue"; instructions: string; additionalAttempts: number }
  | { action: "stop" };
export type OnDeliveryLimit<TTask extends WorkItem = WorkItem> = (
  limit: DeliveryLimit<TTask>,
) => Promise<LimitDecision>;

/** The work performed so far. Use onLimit to continue within the same durable run. */
export interface DeliveryChange<TTask extends WorkItem = WorkItem> {
  task: TTask;
  worktree: WorktreeFacts;
  attempts: DeliveryAttempts;
  sessions: Partial<Record<AgentRoleName, { harness: HarnessConfig; session: AgentSession }>>;
}
/** An approved change, carrying the commit the reviewer judged. */
export interface ApprovedChange<TTask extends WorkItem = WorkItem> extends DeliveryChange<TTask> {
  approval: {
    /**
     * The commit that passed pre-publication review, not the merged head: CI
     * repairs and pull-request revisions push further commits after it.
     */
    reviewedCommit: string;
  };
}
export interface DeliveryStopped<TTask extends WorkItem = WorkItem> {
  status: "limit-reached" | "stopped" | "uncommitted-work";
  phase: DeliveryPhase;
  attempts: number;
  findings: string[];
  change: DeliveryChange<TTask>;
  pr?: PrRef;
}
export type ImplementAndReviewResult<TTask extends WorkItem = WorkItem> =
  | { status: "approved"; change: ApprovedChange<TTask> }
  | DeliveryStopped<TTask>;
export type DeliveryResult<TTask extends WorkItem = WorkItem> =
  | { status: "merged" | "closed"; change: ApprovedChange<TTask>; pr: PrRef }
  | DeliveryStopped<TTask>;

export interface ImplementAndReviewOptions<TTask extends WorkItem = WorkItem> {
  task: TTask;
  worktree: WorktreeFacts;
  implementation: ImplementationAgent<TTask>;
  review: ReviewAgent<TTask>;
  limits: Pick<DeliveryLimits, "implementationReviewRounds">;
  onLimit?: OnDeliveryLimit<TTask>;
}
export interface PublishApprovedChangeOptions<TTask extends WorkItem = WorkItem> {
  change: ApprovedChange<TTask>;
  binding: string;
  implementation: ImplementationAgent<TTask>;
  pullRequestDescription?: DescriptionAgent<TTask>;
}
export interface FollowPullRequestOptions<TTask extends WorkItem = WorkItem> {
  change: ApprovedChange<TTask>;
  pr: PrRef;
  implementation: ImplementationAgent<TTask>;
  ciRepair?: CiRepairAgent<TTask>;
  pullRequestRevision?: PullRequestRevisionAgent<TTask>;
  limits: Pick<DeliveryLimits, "ciFixAttempts" | "pullRequestRevisionRounds">;
  merge: "human" | "jigs";
  onLimit?: OnDeliveryLimit<TTask>;
}
export interface DeliverChangeOptions<TTask extends WorkItem = WorkItem>
  extends Omit<ImplementAndReviewOptions<TTask>, "limits"> {
  binding: string;
  ciRepair?: CiRepairAgent<TTask>;
  pullRequestRevision?: PullRequestRevisionAgent<TTask>;
  pullRequestDescription?: DescriptionAgent<TTask>;
  limits: DeliveryLimits;
  merge: "human" | "jigs";
}

/** Supply the factory's durable functions once, then use the delivery operations. */
export interface DeliverySteps {
  runAgent: AgentFn;
  pullRequestGate: (pr: PrRef) => AsyncGenerator<GateWake, void, GateAck | undefined>;
  readBranchState: typeof branch.readBranchState;
  readWorktreeDiff: typeof branch.readWorktreeDiff;
  pushBranch: typeof branch.pushBranch;
  resolveRepository: typeof pr.resolveRepository;
  openPullRequest: typeof pr.openPullRequest;
  commentOnPullRequest: typeof pr.commentOnPullRequest;
  replyToPullRequestReviewThread: typeof pr.replyToPullRequestReviewThread;
  squashMergePullRequest: typeof pr.squashMergePullRequest;
}
