// Deliver one work item in three phases, each a plain function the workflow
// calls in order: build and review until approved, publish, follow the pull
// request until it merges. A delivery that stops short retains its work and
// throws DeliveryStopped; the workflow decides what to tell whom.

import {
  type ApprovalCoverage,
  blockedMergeNote,
  defaultPullRequestScope,
  type Harness,
  isPullRequestMergeReady,
  JigsError,
  type PullRequestRef,
  type PullRequestSnapshot,
  type TicketNote,
  type Worktree,
} from "@jigs-ai/jigs";
import { sleep } from "workflow";
import { z } from "zod";
import {
  agentSession,
  committedWork,
  postPullRequestNote,
  runAgent,
  watchPullRequest,
} from "#jigs/routines";
import {
  fetchPullRequestState,
  mergePullRequest,
  openPullRequest,
  pushApprovedChange,
  pushBranch,
  readBranchState,
  readWorktreeDiff,
  registerResource,
} from "#jigs/steps";
import * as prompts from "./prompts.ts";
import {
  implementationReport,
  pullRequestDescription,
  type ReviewFinding,
  type ReviewRound,
  renderFinding,
  reviewerNotes,
  reviewVerdict,
} from "./review.ts";
import { builderWakeFacts, commentFacts } from "./wake.ts";

/** The requirements to deliver. Add fields here and they reach every prompt. */
export interface WorkItem {
  id: string;
  key: string;
  title: string;
  instructions: string;
  url?: string | undefined;
}

export interface Budget {
  /** One round is one build plus one review of what it committed. */
  reviewRounds: number;
  /** Builder invocations allowed to handle each changed PR snapshot, including recovery. */
  attemptsPerUpdate: number;
}

export interface Delivery {
  task: WorkItem;
  worktree: Worktree;
  builder: Harness;
  reviewer: Harness;
  budget: Budget;
  /** Who merges the pull request once it is approved and CI is green. */
  mergedBy: "jigs" | "human";
  /** Which commits a person's approving review covers when jigs merges. */
  approvalCovers: ApprovalCoverage;
}

export interface Approved {
  /** The commit the reviewer approved, and the only one publication pushes. */
  reviewedCommit: string;
  ledger: ReviewRound[];
}

// Notes and findings get posted, on the ticket and wherever a caller sends
// them, so they never carry the operator's local worktree path. The run's
// worktree resource shows it locally, in `jigs status`.
const withoutLocalPath = (worktree: Worktree, text: string) =>
  text.replaceAll(worktree.path, "the run's worktree");

const workLocation = (worktree: Worktree) =>
  `The work is on branch \`${worktree.branch}\`, in the run's local worktree, which \`jigs status\` lists.`;

/** Thrown when a delivery stops short; local work remains available. */
export class DeliveryStopped extends JigsError {
  readonly findings: string[];
  readonly worktree: Worktree;
  readonly closing: string;

  constructor(
    message: string,
    findings: string[],
    worktree: Worktree,
    closing = "Nothing is waiting on a reply here. Another run starts over on a new branch; to keep this work, take the branch (and its pull request, if any) over by hand.",
  ) {
    const posted = findings.map((finding) => withoutLocalPath(worktree, finding));
    super(withoutLocalPath(worktree, message), posted.length === 0 ? undefined : posted.join("\n"));
    this.name = "DeliveryStopped";
    this.findings = posted;
    this.worktree = worktree;
    this.closing = closing;
  }

  /** What to tell a person: what is still open and where the work is. */
  note(): TicketNote {
    return {
      headline: this.message,
      notes: [...this.findings, workLocation(this.worktree)],
      closing: this.closing,
    };
  }
}

export const maintenanceReport = z.strictObject({
  status: z.enum(["finished", "pending", "needs-human"]),
  summary: z.string().min(1),
});

type BuilderSession = ReturnType<typeof agentSession>;

// ---- phase 1: build and review until approved ------------------------------

export async function implementAndReview(
  delivery: Delivery,
  builderSession: BuilderSession,
): Promise<Approved> {
  const { task, worktree, budget } = delivery;
  const cwd = worktree.path;
  const reviewerSession = agentSession({ name: "reviewer", harness: delivery.reviewer, cwd });
  const diff = () => readWorktreeDiff(worktree);
  const ledger: ReviewRound[] = [];
  let findings: ReviewFinding[] = [];

  for (let round = 1; round <= budget.reviewRounds; round++) {
    const report = await builderSession.run({
      output: implementationReport,
      resume: prompts.implementation.resume(findings),
      fresh: async () => prompts.implementation.fresh(task, worktree, findings, await diff()),
    });

    const state = await committedWork(worktree).catch((error: unknown) => {
      if (!(error instanceof JigsError)) throw error;
      return stop(delivery, `jigs stopped work on ${task.key} in review round ${round}.`, [
        `${error.message}; ${error.hint}`,
      ]);
    });

    const current = await diff();
    const verdict = await reviewerSession.run({
      output: reviewVerdict,
      resume: prompts.review.resume(state.headSha, current, report.responses),
      fresh: prompts.review.fresh(task, worktree, state.headSha, current, ledger),
    });

    // `blocking` decides, not the stated verdict: an approval that carries a
    // blocking finding is the reviewer contradicting itself.
    findings = verdict.findings;
    const blocking = findings.some((finding) => finding.blocking);
    ledger.push({
      round,
      responses: report.responses,
      verdict: blocking ? "changes-requested" : "approved",
      findings,
    });
    if (!blocking) return { reviewedCommit: state.headSha, ledger };
  }

  return stop(
    delivery,
    `jigs stopped work on ${task.key} after ${budget.reviewRounds} review round(s) without an approved change.`,
    findings.map(renderFinding),
  );
}

// ---- phase 2: publish the reviewed commit ------------------------------------

export async function publish(
  delivery: Delivery,
  approved: Approved,
): Promise<PullRequestRef & { url: string }> {
  const { task, worktree } = delivery;
  // Described before the push, so a failed description leaves no branch
  // on the remote without a pull request.
  const { output: described } = await runAgent({
    harness: delivery.builder,
    cwd: worktree.path,
    prompt: prompts.description.fresh(task, worktree, await readWorktreeDiff(worktree)),
    output: pullRequestDescription,
  });

  // Appended here rather than asked of the agent: the reviewer's remaining
  // observations are the one part of the body a model must not leave out.
  const notes = reviewerNotes(approved.ledger);
  const body =
    notes.length === 0
      ? described.body
      : `${described.body}\n\n## Reviewer notes\n\n${notes.map((note) => `- ${note}`).join("\n")}`;

  await pushApprovedChange(worktree, approved.reviewedCommit);
  const pr = await openPullRequest({ worktree, title: described.title, body });
  await registerResource({
    kind: "pull-request",
    identity: `${pr.owner}/${pr.repo}#${pr.number}`,
    url: pr.url,
  });
  return pr;
}

// ---- phase 3: follow the pull request until it merges -------------------------

export interface Maintenance {
  /**
   * Tell a person that the pull request needs them. Maintenance keeps watching
   * afterwards: the next change to the pull request picks the work back up.
   */
  onNeedsHuman: (note: TicketNote) => Promise<void>;
}

const MERGE_TRIES = 10;

type LocalState = { dirty: boolean; headSha: string };

/** What one pull request's maintenance remembers between watcher yields. */
interface Following extends Maintenance {
  delivery: Delivery;
  pr: PullRequestRef;
  builder: BuilderSession;
  /** Wake facts the builder has already been shown. */
  seen: Set<string>;
  /** Every head the pull request has had, as read from GitHub. */
  prHeads: Set<string>;
  lastNote?: string;
  /** Unpublished local state recovery gave up on; only a change to it wakes the builder again. */
  heldLocal?: string | undefined;
}

export async function followPullRequest(
  delivery: Delivery,
  pr: PullRequestRef,
  builder: BuilderSession,
  { onNeedsHuman }: Maintenance,
): Promise<void> {
  const following: Following = {
    delivery,
    pr,
    builder,
    onNeedsHuman,
    seen: new Set(),
    prHeads: new Set(),
  };
  for await (const snapshot of watchPullRequest(pr, { approvalCovers: delivery.approvalCovers })) {
    let current = observe(following, snapshot);
    if (current.state === "open") {
      const local = await readBranchState(delivery.worktree);
      const recover = !isPublished(following, local) && following.heldLocal !== localKey(local);
      if (recover || hasUnseenFacts(following, current)) {
        current = await maintain(following, current, local);
        // A newly pushed head is merged only from its own watcher yield.
        if (current.state === "open" && current.headSha !== snapshot.headSha) continue;
      }
    }
    if (current.state === "closed") {
      if (current.merged) return;
      throw maintenanceStopped(delivery, pr, "The pull request was closed unmerged.");
    }
    // Checked after every yield and every builder turn: a turn that changes
    // nothing on GitHub produces no new yield to merge on.
    if (await mergeIfReady(following, current)) return;
  }

  throw new JigsError(
    `the pull request watch for ${pr.owner}/${pr.repo}#${pr.number} ended without a close`,
  );
}

function observe(following: Following, snapshot: PullRequestSnapshot) {
  following.prHeads.add(snapshot.headSha);
  return snapshot;
}

const hasUnseenFacts = (following: Following, snapshot: PullRequestSnapshot) =>
  builderWakeFacts(snapshot, noteScope(following)).some((fact) => !following.seen.has(fact));

// Local work behind the PR is fine (a person pushed); work the PR never had is not.
const isPublished = (following: Following, local: LocalState) =>
  !local.dirty && following.prHeads.has(local.headSha);

const localKey = (local: LocalState) => `${local.dirty}:${local.headSha}`;

const recoveryFacts = (local: LocalState, current: PullRequestSnapshot) =>
  [
    `The worktree is ${local.dirty ? "dirty (uncommitted changes remain)" : "clean"}.`,
    `Local HEAD: ${local.headSha}. Published PR head: ${current.headSha}.`,
    "Inspect these facts and safely finish, commit, push, or synchronize the work as needed. Do not discard work or force-push.",
  ].join(" ");

const HELD =
  " Local work that is not on the pull request holds back the merge until the worktree is clean and its HEAD is a commit the pull request has had.";

// Returns what to add to a note when local work holds back the merge.
function holdUnpublished(following: Following, local: LocalState): string {
  const held = !isPublished(following, local);
  following.heldLocal = held ? localKey(local) : undefined;
  return held ? HELD : "";
}

async function needsHuman(following: Following, reason: string) {
  if (reason === following.lastNote) return;
  following.lastNote = reason;
  await following.onNeedsHuman(maintenanceNote(following.delivery, following.pr, reason));
}

// The builder posts as the operator, so its comments cannot be told apart by
// author. Comments that appear during its turn count as its own; a human
// comment landing in that window is absorbed too. It never submits reviews.
async function readAfterTurn(following: Following): Promise<PullRequestSnapshot> {
  const { pr, delivery } = following;
  const current = observe(
    following,
    await fetchPullRequestState(pr, { approvalCovers: delivery.approvalCovers }),
  );
  for (const fact of commentFacts(current, noteScope(following))) following.seen.add(fact);
  return current;
}

// Builder turns for one update, until local work is published or the attempts
// run out.
async function maintain(
  following: Following,
  snapshot: PullRequestSnapshot,
  before: LocalState,
): Promise<PullRequestSnapshot> {
  const { delivery, pr, builder } = following;
  const { task, worktree, budget } = delivery;
  let assessed = snapshot;
  let current = snapshot;
  let recovery = isPublished(following, before) ? undefined : recoveryFacts(before, snapshot);
  for (let attempt = 1; attempt <= budget.attemptsPerUpdate; attempt++) {
    const report = await builder.run({
      output: maintenanceReport,
      resume: prompts.maintenance.resume(pr, assessed, recovery),
      fresh: async () =>
        prompts.maintenance.fresh(
          task,
          worktree,
          await readWorktreeDiff(worktree),
          pr,
          assessed,
          recovery,
        ),
    });
    // Remember only what the builder saw, never a newer post-turn read.
    for (const fact of builderWakeFacts(assessed, noteScope(following))) following.seen.add(fact);
    let local = await readBranchState(worktree);
    current = await readAfterTurn(following);
    if (current.state === "closed") return current;
    if (report.status === "needs-human") {
      const held = holdUnpublished(following, local);
      await needsHuman(following, `The builder needs a person: ${report.summary}${held}`);
      return current;
    }

    // A successful push may reach GitHub's PR reader shortly afterward.
    // These two durable waits do not consume another builder attempt.
    for (
      let recheck = 0;
      !local.dirty && !isPublished(following, local) && recheck < 2;
      recheck++
    ) {
      await sleep("2s");
      current = await readAfterTurn(following);
      local = await readBranchState(worktree);
      if (current.state === "closed") return current;
    }

    if (holdUnpublished(following, local) === "") return current;
    recovery = recoveryFacts(local, current);
    // Recovery is local work, not an external event: retry without waiting
    // for a new watcher yield, even if GitHub has not changed at all.
    assessed = current;
  }
  await needsHuman(
    following,
    `Exhausted ${budget.attemptsPerUpdate} attempts for this pull request update. ${recovery}${HELD}`,
  );
  return current;
}

// Readiness is GitHub's to decide, not the builder's: an approved, green,
// clean head merges whatever the builder last reported.
async function mergeIfReady(following: Following, snapshot: PullRequestSnapshot) {
  const { delivery, pr } = following;
  if (delivery.mergedBy !== "jigs") return false;
  let current = snapshot;
  let reason = "";
  for (let attempt = 1; attempt <= MERGE_TRIES; attempt++) {
    if (attempt > 1) {
      await sleep("30s");
      current = observe(
        following,
        await fetchPullRequestState(pr, { approvalCovers: delivery.approvalCovers }),
      );
    }
    if (current.state !== "open" || hasUnseenFacts(following, current)) return false;
    if (!isPullRequestMergeReady(current)) {
      await noteBlockedMerge(following, current);
      // After a refusal, keep polling: GitHub settling back to the yielded
      // state matches the watcher's last key, so the watcher would never yield it.
      if (attempt > 1) continue;
      return false;
    }
    if (!isPublished(following, await readBranchState(delivery.worktree))) return false;
    const result = await mergePullRequest(delivery.worktree, pr, current.headSha, {
      approvalCovers: delivery.approvalCovers,
    }).catch((error: unknown) => ({
      merged: false as const,
      reason: String(error),
      transient: true,
    }));
    if (result.merged) return true;
    if (!result.transient) {
      await needsHuman(following, `Could not merge the pull request: ${result.reason}`);
      return false;
    }
    reason = result.reason;
  }
  await needsHuman(
    following,
    `Could not merge the pull request after ${MERGE_TRIES} tries: ${reason}`,
  );
  return false;
}

const noteScope = (following: Following) => defaultPullRequestScope(following.delivery.task.key);

// The note's marker keeps it to one per head, across wakes and runs.
async function noteBlockedMerge(following: Following, snapshot: PullRequestSnapshot) {
  const body = blockedMergeNote(snapshot);
  if (body === null) return;
  await postPullRequestNote({
    pr: following.pr,
    scope: noteScope(following),
    headSha: snapshot.headSha,
    reason: "merge-retry",
    body,
  });
}

const prUrl = (pr: PullRequestRef) => `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;

function maintenanceNote(delivery: Delivery, pr: PullRequestRef, reason: string): TicketNote {
  const { task, worktree } = delivery;
  return {
    headline: `jigs needs a person to move the pull request for ${task.key} forward.`,
    notes: [
      withoutLocalPath(worktree, reason),
      `Pull request: ${prUrl(pr)}`,
      workLocation(worktree),
    ],
    closing:
      "jigs is still watching the pull request: the next change to it, such as a re-run check, a new comment or review, or an approval, picks the work back up.",
  };
}

// An unresolved local/publication state must never be pushed as a side effect
// of stopping. Keep it available for the person taking over.
function maintenanceStopped(delivery: Delivery, pr: PullRequestRef, reason: string) {
  return new DeliveryStopped(
    `jigs stopped pull request maintenance for ${delivery.task.key}.`,
    [
      reason,
      `Unfinished pull request: ${prUrl(pr)}`,
      "Local work was retained without an automatic push.",
    ],
    delivery.worktree,
    "Inspect the existing pull request and retained worktree, then take over the unfinished work by hand.",
  );
}

// Before publication, try to preserve implementation commits remotely, then
// throw with what is still open. Maintenance deliberately does not call this.
async function stop(delivery: Delivery, reason: string, findings: string[]): Promise<never> {
  const retained = [...findings];
  await pushBranch(delivery.worktree).catch((error: unknown) => {
    retained.push(`Could not push the branch: ${String(error)}.`);
  });
  throw new DeliveryStopped(reason, retained, delivery.worktree);
}
