import type { CheckRun, PrRef, ReviewThread } from "../../providers/github.ts";
import type * as branch from "../../steps/pull-request/branch.ts";
import type * as pr from "../../steps/pull-request/pr.ts";
import type { HarnessConfig } from "../agent/harness-config.ts";
import type { AgentSession } from "../agent/result.ts";
import type { AgentFn } from "../agent/resume-or-rebuild.ts";
import type { PullRequestDescription } from "../builder-agent/describe-pr.ts";
import type { GateAck, GateWake } from "../pull-request/gate.ts";
import type { WorktreeFacts } from "../worktree.ts";

/**
 * The requirements to deliver, independent of where they were recorded. A
 * factory's own task type extends this, and its extra fields reach every
 * prompt context, `onLimit` and the result without a cast.
 */
export interface WorkItem {
  /** Short human-facing identifier, as the prompts name the task. */
  key: string;
  /** One-line summary of the work, as the prompts and the pull request name it. */
  title: string;
  /** What to build, in full: the only statement of the requirements an agent is given. */
  instructions: string;
  /** Where a reader can see the work item itself, when it has an address. */
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
  /** Read the diff when needed; available only for a fresh or rebuilt session. */
  readDiff?: () => Promise<string>;
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
  /** Read the diff when needed; available only for a fresh or rebuilt session. */
  readDiff?: () => Promise<string>;
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
  /** Read the diff when needed; available only for a fresh or rebuilt session. */
  readDiff?: () => Promise<string>;
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

/**
 * The budgets a delivery runs under. Each phase spends its own and no other,
 * each counts cumulatively for the life of the delivery, and an `onLimit`
 * continuation raises the exhausted one within the same durable run.
 */
export interface DeliveryLimits {
  /**
   * Rounds before implementation stops. One round is one implementation
   * attempt plus one review of what that attempt committed.
   */
  implementationReviewRounds: number;
  /**
   * Repair attempts against failing checks, spent after publication over the
   * pull request's whole life. A red head already repaired is not charged again.
   */
  ciFixAttempts: number;
  /**
   * Rounds spent answering pull-request review feedback after publication. One
   * batch of threads, or one changes-requested review, is one round.
   */
  pullRequestRevisionRounds: number;
}

/**
 * What a delivery has spent, under the same names as its budgets. These count
 * what actually ran; `DeliveryLimits` bounds what may. A granted continuation
 * raises the bound and leaves these untouched, so they only ever go up.
 */
export interface DeliveryAttempts {
  /** Implementation attempts made, each with its review. */
  implementationReviewRounds: number;
  /** CI repair attempts made against the published pull request. */
  ciFixAttempts: number;
  /** Batches of pull-request review feedback answered. */
  pullRequestRevisionRounds: number;
}

/** A phase that has spent its budget, handed to `onLimit` to decide what follows. */
export interface LimitReached<TTask extends WorkItem = WorkItem> {
  /** Which budget ran out; only this one a continuation can raise. */
  phase: DeliveryPhase;
  /** Attempts already spent in that phase, never reset. */
  attempts: number;
  /** Why the phase is still unfinished: review findings, failing checks, or the review summary. */
  findings: string[];
  task: TTask;
  worktree: WorktreeFacts;
  /** Present once the change is published, so the two post-publication phases carry it. */
  pr?: PrRef;
}

/** What `onLimit` returns: keep going on stated direction, or end the delivery here. */
export type LimitDecision =
  | {
      action: "continue";
      /** Reaches the next attempt as its `instructions`, and every attempt after it. */
      instructions: string;
      /** Added to the exhausted phase's budget. At least 1. */
      additionalAttempts: number;
    }
  | { action: "stop" };

/**
 * Workflow-side, so it may suspend: asking a human on the ticket and awaiting
 * the reply is the intended shape. Never pass it through a durable step argument.
 */
export type OnDeliveryLimit<TTask extends WorkItem = WorkItem> = (
  limit: LimitReached<TTask>,
) => Promise<LimitDecision>;

/**
 * The work performed so far. It is a record, not a checkpoint: a returned
 * change cannot restart an interrupted phase in a new run, and `onLimit` is
 * what continues one within the same durable run.
 */
export interface DeliveryChange<TTask extends WorkItem = WorkItem> {
  task: TTask;
  worktree: WorktreeFacts;
  attempts: DeliveryAttempts;
  /**
   * Each role's live agent session, kept so the next attempt resumes rather
   * than rebuilds. Dropped for a role whose harness configuration changed.
   */
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
/** A delivery that ended without a merge or a closure. The worktree is retained. */
export interface DeliveryStopped<TTask extends WorkItem = WorkItem> {
  /**
   * `limit-reached` when a budget ran out with no `onLimit`, `stopped` when
   * `onLimit` declined or a repair produced nothing usable, and
   * `uncommitted-work` when an implementation attempt left nothing reviewable.
   */
  status: "limit-reached" | "stopped" | "uncommitted-work";
  phase: DeliveryPhase;
  attempts: number;
  /** Why it stopped here: findings, failing checks, or the reason nothing was reviewable. */
  findings: string[];
  change: DeliveryChange<TTask>;
  pr?: PrRef;
}
/** Approved carries the reviewed commit; nothing else is publishable. */
export type ImplementAndReviewResult<TTask extends WorkItem = WorkItem> =
  | { status: "approved"; change: ApprovedChange<TTask> }
  | DeliveryStopped<TTask>;
/** Remove the worktree only on `merged`; every other outcome may still be worked on. */
export type DeliveryResult<TTask extends WorkItem = WorkItem> =
  | { status: "merged" | "closed"; change: ApprovedChange<TTask>; pr: PrRef }
  | DeliveryStopped<TTask>;

export interface ImplementAndReviewOptions<TTask extends WorkItem = WorkItem> {
  /** Recorded durably, so keep it plain serializable data. */
  task: TTask;
  worktree: WorktreeFacts;
  implementation: ImplementationAgent<TTask>;
  review: ReviewAgent<TTask>;
  limits: Pick<DeliveryLimits, "implementationReviewRounds">;
  onLimit?: OnDeliveryLimit<TTask>;
}
export interface PublishApprovedChangeOptions<TTask extends WorkItem = WorkItem> {
  change: ApprovedChange<TTask>;
  /** The factory binding naming the GitHub repository to open the pull request on. */
  binding: string;
  /** Supplies the harness the description is written with when no description role is given. */
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
  /** `jigs` squash-merges once the pull request is mergeable; `human` only keeps watching. */
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
  pushApprovedChange: typeof branch.pushApprovedChange;
  resolveRepository: typeof pr.resolveRepository;
  openPullRequest: typeof pr.openPullRequest;
  commentOnPullRequest: typeof pr.commentOnPullRequest;
  replyToPullRequestReviewThread: typeof pr.replyToPullRequestReviewThread;
  squashMergePullRequest: typeof pr.squashMergePullRequest;
}
