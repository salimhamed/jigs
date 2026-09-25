import type { PullRequestRef, PullRequestWake } from "@jigs-ai/jigs";

type CheckRun = Extract<PullRequestWake, { kind: "ci-red" }>["failing"][number];
type ReviewThread = Extract<PullRequestWake, { kind: "review-comments" }>["threads"][number];

import type { Harness, MergePolicy, TicketNote, Worktree } from "@jigs-ai/jigs";
import type { PullRequestDescription } from "./outputs.ts";
import type { FindingResponse, ReviewFinding, ReviewRound } from "./review.ts";

/**
 * The requirements to deliver, independent of where they were recorded. A
 * factory's own task type extends this, and its extra fields reach every
 * prompt context, `onLimit` and the result without a cast.
 */
export interface WorkItem {
  /**
   * The work item's address at its source — a Linear issue UUID, say. `key`
   * is what a human reads.
   */
  id: string;
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

/**
 * What every role is told, whatever its job: the work item as the factory
 * wrote it, the worktree it is checked out in, which attempt of its phase this
 * is, and the prompt the recipe would have sent if the role had no callback.
 */
interface RolePromptContext<TTask extends WorkItem> {
  task: TTask;
  worktree: Worktree;
  /** Counts attempts of this role's phase; 1 on the first one. */
  attempt: number;
  /**
   * Renders the recipe’s default prompt for this attempt. Await it and add to
   * the result to extend the default; ignore it and return a string of your
   * own to replace the default entirely. Either is a first-class use.
   */
  renderDefaultPrompt: () => Promise<string>;
}

/** Write the change and commit it. */
export interface ImplementationPromptContext<TTask extends WorkItem = WorkItem>
  extends RolePromptContext<TTask> {
  /** The previous round's review findings; empty on the first round. */
  findings: ReviewFinding[];
  /** Direction an `onLimit` continuation supplied; empty until a limit is extended. */
  instructions: string;
  /** Read the diff when needed; available only for a fresh or rebuilt session. */
  readDiff?: () => Promise<string>;
}

/**
 * Judge the committed work. The reviewer keeps its own session across rounds,
 * so a resumed one is told only what is new: the current diff and the builder's
 * answer to what it last raised. `ledger` is what a reviewer holding nothing is
 * given instead, so either way a round N verdict knows rounds 1..N-1.
 */
export interface ReviewPromptContext<TTask extends WorkItem = WorkItem>
  extends RolePromptContext<TTask> {
  baseCommit: string;
  /** The commit being reviewed, and the only one publication will accept. */
  headCommit: string;
  diff: string;
  /** Direction an `onLimit` continuation supplied; empty until a limit is extended. */
  instructions: string;
  /** The builder's answer to each of the last round's findings; empty on the first round. */
  responses: FindingResponse[];
  /** Every earlier round; supplied only when the reviewer holds no session of its own. */
  ledger?: ReviewRound[];
}

/** Repair the pull request's failing checks. */
export interface CiRepairPromptContext<TTask extends WorkItem = WorkItem>
  extends RolePromptContext<TTask> {
  failing: CheckRun[];
  pr: PullRequestRef;
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
  reviewBody?: string | undefined;
  pr: PullRequestRef;
  /** Direction an `onLimit` continuation supplied; empty until a limit is extended. */
  instructions: string;
  /** Read the diff when needed; available only for a fresh or rebuilt session. */
  readDiff?: () => Promise<string>;
}

/** Describe the approved change. Runs once, against the commit about to be published. */
export interface DescriptionPromptContext<TTask extends WorkItem = WorkItem> {
  task: TTask;
  worktree: Worktree;
  diff: string;
  /**
   * Renders the recipe’s default prompt. Await it and add to the result to
   * extend the default; ignore it and return a string of your own to replace
   * the default entirely. Either is a first-class use.
   */
  renderDefaultPrompt: () => Promise<string>;
}

/** A harness, and optionally the prompt its role is given instead of the default. */
export interface DeliveryAgent<TContext> {
  harness: Harness;
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
  worktree: Worktree;
  /** Present once the change is published, so the two post-publication phases carry it. */
  pr?: PullRequestRef;
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
 * Runs inside the workflow, so it may suspend: asking a human on the ticket and awaiting
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
  worktree: Worktree;
  attempts: DeliveryAttempts;
  /**
   * Every implementation-review round in order. It is what a rebuilt reviewer
   * is given in place of its lost session, and where the approving round's
   * non-blocking findings are read from for the pull request body.
   */
  review: ReviewRound[];
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
/** Approved carries the reviewed commit; a stopped delivery throws instead. */
export type ImplementAndReviewResult<TTask extends WorkItem = WorkItem> = {
  change: ApprovedChange<TTask>;
};
/** A delivery returns only after its pull request merged. */
export type DeliveryResult<TTask extends WorkItem = WorkItem> = {
  change: ApprovedChange<TTask>;
  pr: PullRequestRef;
};

export interface ImplementAndReviewOptions<TTask extends WorkItem = WorkItem> {
  /** Recorded durably, so keep it plain serializable data. */
  task: TTask;
  worktree: Worktree;
  implementation: ImplementationAgent<TTask>;
  review: ReviewAgent<TTask>;
  limits: Pick<DeliveryLimits, "implementationReviewRounds">;
  /**
   * Posts the note a delivery leaves when it stops short: what is still open
   * and where the pushed branch is. A ticket-driven workflow posts it through
   * its claim with `noteOnTicket`, so a later halt never reads it as a reply.
   */
  postNote: PostDeliveryNote;
  onLimit?: OnDeliveryLimit<TTask>;
  on?: DeliveryCallbacks;
}
export interface PublishApprovedChangeOptions<TTask extends WorkItem = WorkItem> {
  change: ApprovedChange<TTask>;
  /** The factory binding naming the GitHub repository to open the pull request on. */
  binding: string;
  /** Supplies the harness the description is written with when no description role is given. */
  implementation: ImplementationAgent<TTask>;
  pullRequestDescription?: DescriptionAgent<TTask>;
  on?: DeliveryCallbacks;
}
export interface FollowPullRequestOptions<TTask extends WorkItem = WorkItem> {
  change: ApprovedChange<TTask>;
  pr: PullRequestRef;
  /**
   * The continuation identity written into every comment this delivery posts,
   * and the one it reads back to see what it has already done. Defaults to
   * this workflow's name and the task's key. Name it explicitly to continue
   * another workflow's work on the pull request, or to start a fresh
   * assessment of one.
   */
  scope?: string;
  implementation: ImplementationAgent<TTask>;
  ciRepair?: CiRepairAgent<TTask>;
  pullRequestRevision?: PullRequestRevisionAgent<TTask>;
  limits: Pick<DeliveryLimits, "ciFixAttempts" | "pullRequestRevisionRounds">;
  /**
   * Who merges, by which method, and what signal permits it. `by: "jigs"`
   * merges with `method` as soon as `approval` is satisfied and GitHub reports
   * the pull request mergeable; `by: "human"` only keeps watching. The factory
   * states it in `jigs.config.ts`; `resolveMergePolicy(binding)` reads it.
   */
  merge: MergePolicy;
  /** See {@link ImplementAndReviewOptions.postNote}. */
  postNote: PostDeliveryNote;
  onLimit?: OnDeliveryLimit<TTask>;
  on?: DeliveryCallbacks;
}

/** Where a delivery that stops short says so, in the shape of a ticket note. */
export type PostDeliveryNote = (note: TicketNote) => Promise<void>;

/** Workflow policy at the delivery lifecycle moments the recipe owns. */
export interface DeliveryCallbacks {
  pullRequestOpened?: (pr: PullRequestRef) => Promise<void>;
  merged?: (pr: PullRequestRef) => Promise<void>;
  stopped?: (reason: string) => Promise<void>;
}
export interface DeliverChangeOptions<TTask extends WorkItem = WorkItem>
  extends Omit<ImplementAndReviewOptions<TTask>, "limits"> {
  binding: string;
  ciRepair?: CiRepairAgent<TTask>;
  pullRequestRevision?: PullRequestRevisionAgent<TTask>;
  pullRequestDescription?: DescriptionAgent<TTask>;
  limits: DeliveryLimits;
  /** See {@link FollowPullRequestOptions.merge}. */
  merge: MergePolicy;
  /** See {@link FollowPullRequestOptions.scope}. */
  scope?: string;
}
