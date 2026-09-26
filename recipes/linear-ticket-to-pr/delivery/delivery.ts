// Deliver one work item in three phases, each a plain function the workflow
// calls in order: build and review until approved, publish, follow the pull
// request until it merges. A delivery that stops short retains its work and
// throws DeliveryStopped; the workflow decides what to tell whom.

import {
  type Harness,
  isPullRequestMergeReady,
  JigsError,
  jevModel,
  type PullRequestRef,
  type PullRequestSnapshot,
  pullRequestSnapshotKey,
  type TicketNote,
  type Worktree,
} from "@jigs-ai/jigs";
import { sleep } from "workflow";
import { z } from "zod";
import {
  agentSession,
  askJev,
  committedWork,
  decide,
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
import {
  CUTOFF,
  commentKind,
  type NewComment,
  type PullRequestWakeState,
  pullRequestWake,
  quietKinds,
  type ReviewConvergenceState,
  reviewConvergence,
  STALLED,
} from "./decisions.ts";
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
}

export interface Approved {
  /** The commit the reviewer approved, and the only one publication pushes. */
  reviewedCommit: string;
  ledger: ReviewRound[];
}

/** Thrown when a delivery stops short; local work remains available. */
export class DeliveryStopped extends JigsError {
  readonly findings: string[];
  readonly worktree: Worktree;
  readonly closing: string;

  constructor(
    message: string,
    findings: string[],
    worktree: Worktree,
    closing = "Nothing is waiting on a reply here. Start another run to continue, or take the branch over by hand.",
  ) {
    super(message, findings.length === 0 ? undefined : findings.join("\n"));
    this.name = "DeliveryStopped";
    this.findings = findings;
    this.worktree = worktree;
    this.closing = closing;
  }

  /** What to tell a person: what is still open and where the work is. */
  note(): TicketNote {
    return {
      headline: this.message,
      notes: [
        ...this.findings,
        `The work is on branch \`${this.worktree.branch}\`, in the worktree at \`${this.worktree.path}\`.`,
      ],
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

    if (round >= 2 && round < budget.reviewRounds) {
      const progress = await decide({
        site: "review-convergence",
        state: convergenceState(ledger, budget.reviewRounds),
        question: reviewConvergence,
        cutoff: CUTOFF,
      });
      if (progress.confident && Math.round(progress.answer.score) === STALLED)
        return stop(
          delivery,
          `jigs stopped work on ${task.key} after ${round} of ${budget.reviewRounds} review round(s): the same blocking findings keep coming back.`,
          findings.map(renderFinding),
        );
    }
  }

  return stop(
    delivery,
    `jigs stopped work on ${task.key} after ${budget.reviewRounds} review round(s) without an approved change.`,
    findings.map(renderFinding),
  );
}

function convergenceState(ledger: ReviewRound[], budget: number): ReviewConvergenceState {
  return {
    budget,
    rounds: ledger.map((round) => ({
      round: round.round,
      blocking: round.findings.filter((f) => f.blocking).map((f) => f.summary),
      nonBlocking: round.findings.filter((f) => !f.blocking).length,
      responses: round.responses.map((r) => ({ finding: r.finding, changed: r.changed })),
    })),
  };
}

// ---- phase 2: publish the reviewed commit ------------------------------------

export async function publish(
  delivery: Delivery,
  approved: Approved,
): Promise<PullRequestRef & { url: string }> {
  const { task, worktree } = delivery;
  await pushApprovedChange(worktree, approved.reviewedCommit);

  const described = await runAgent({
    harness: delivery.builder,
    cwd: worktree.path,
    prompt: prompts.description(task, worktree, await readWorktreeDiff(worktree)),
    output: pullRequestDescription,
  });

  // Appended here rather than asked of the agent: the reviewer's remaining
  // observations are the one part of the body a model must not leave out.
  const notes = reviewerNotes(approved.ledger);
  const body =
    notes.length === 0
      ? described.output.body
      : `${described.output.body}\n\n## Reviewer notes\n\n${notes.map((note) => `- ${note}`).join("\n")}`;

  const pr = await openPullRequest({
    worktree,
    title: described.output.title,
    body,
  });
  await registerResource({
    kind: "pull-request",
    identity: `${pr.owner}/${pr.repo}#${pr.number}`,
    url: pr.url,
  });
  return pr;
}

// ---- phase 3: follow the pull request until it merges -------------------------

export async function followPullRequest(
  delivery: Delivery,
  pr: PullRequestRef,
  builder: BuilderSession,
): Promise<void> {
  const { task, worktree, budget } = delivery;
  let lastAssessed: string | undefined;
  let assessedBefore: PullRequestSnapshot | undefined;
  const skip = (snapshot: PullRequestSnapshot) => {
    lastAssessed = pullRequestSnapshotKey(snapshot);
    assessedBefore = snapshot;
  };
  for await (const snapshot of watchPullRequest(pr)) {
    if (snapshot.state === "closed") {
      if (snapshot.merged) return;
      return maintenanceStopped(delivery, pr, "The pull request was closed unmerged.");
    }

    if (pullRequestSnapshotKey(snapshot) === lastAssessed) continue;

    const { wake, triaged } = await judgeWake(snapshot, assessedBefore);
    if (wake === "idle") {
      skip(snapshot);
      continue;
    }
    if (wake === "human") {
      const latest = triaged.filter((comment) => !quietKinds.has(comment.kind ?? "")).at(-1);
      return maintenanceStopped(
        delivery,
        pr,
        `The pull request needs a person's decision${latest === undefined ? "" : `, most recently from ${latest.user}: "${latest.body}"`}`,
      );
    }
    if (wake === "merge") {
      if (delivery.mergedBy === "human") {
        skip(snapshot);
        continue;
      }
      // Jev's judgement never merges on its own: the exact readiness gate on
      // freshly read facts still decides, and anything new goes to the builder.
      const current = await fetchPullRequestState(pr);
      if (current.state === "closed") {
        if (current.merged) return;
        return maintenanceStopped(delivery, pr, "The pull request was closed unmerged.");
      }
      if (
        pullRequestSnapshotKey(current) === pullRequestSnapshotKey(snapshot) &&
        isPullRequestMergeReady(current)
      )
        return merge(delivery, pr, current.headSha);
    }

    let assessed = snapshot;
    let recovery: string | undefined;
    for (let attempt = 1; attempt <= budget.attemptsPerUpdate; attempt++) {
      const report = await builder.run({
        output: maintenanceReport,
        resume: prompts.maintenance.resume(pr, assessed, recovery, triaged),
        fresh: async () =>
          prompts.maintenance.fresh(
            task,
            worktree,
            await readWorktreeDiff(worktree),
            pr,
            assessed,
            recovery,
            triaged,
          ),
      });
      let local = await readBranchState(worktree);
      let current = await fetchPullRequestState(pr);
      if (current.state === "closed") {
        if (current.merged) return;
        return maintenanceStopped(delivery, pr, "The pull request was closed unmerged.");
      }
      if (report.status === "needs-human") {
        return maintenanceStopped(
          delivery,
          pr,
          `The builder needs human attention: ${report.summary}`,
        );
      }

      // A successful push may reach GitHub's PR reader shortly afterward.
      // These two durable waits do not consume another builder attempt.
      for (
        let recheck = 0;
        !local.dirty && local.headSha !== current.headSha && recheck < 2;
        recheck++
      ) {
        await sleep("2s");
        current = await fetchPullRequestState(pr);
        local = await readBranchState(worktree);
        if (current.state === "closed") {
          if (current.merged) return;
          return maintenanceStopped(delivery, pr, "The pull request was closed unmerged.");
        }
      }

      if (local.dirty || local.headSha !== current.headSha) {
        recovery = [
          `The worktree is ${local.dirty ? "dirty (uncommitted changes remain)" : "clean"}.`,
          `Local HEAD: ${local.headSha}. Published PR head: ${current.headSha}.`,
          "Inspect these facts and safely finish, commit, push, or synchronize the work as needed. Do not discard work or force-push.",
        ].join(" ");
        if (attempt === budget.attemptsPerUpdate) {
          return maintenanceStopped(
            delivery,
            pr,
            `Exhausted ${budget.attemptsPerUpdate} attempts for this pull request update. ${recovery}`,
          );
        }
        // Recovery is local work, not an external event: retry without waiting
        // for a new watcher yield, even if GitHub has not changed at all.
        assessed = current;
        continue;
      }

      // Recovery may have assessed facts the watcher has not yielded yet.
      // Remember only what the builder saw, never a newer post-turn read.
      skip(assessed);

      // Pending means the builder is waiting for an external event. A newly
      // published head or changed discussion is assessed on the next watch yield.
      if (
        report.status !== "finished" ||
        delivery.mergedBy === "human" ||
        pullRequestSnapshotKey(current) !== pullRequestSnapshotKey(assessed) ||
        !isPullRequestMergeReady(current)
      )
        break;

      return merge(delivery, pr, current.headSha);
    }
  }

  throw new JigsError(
    `the pull request watch for ${pr.owner}/${pr.repo}#${pr.number} ended without a close`,
  );
}

async function merge(delivery: Delivery, pr: PullRequestRef, headSha: string): Promise<void> {
  const result = await mergePullRequest(delivery.worktree, pr, headSha).catch((error: unknown) => ({
    merged: false as const,
    reason: String(error),
    transient: true,
  }));
  if (result.merged) return;
  return maintenanceStopped(delivery, pr, `Could not merge the pull request: ${result.reason}`);
}

type Wake = "idle" | "builder" | "human" | "merge";

// Newest first, so a burst of comments keeps the ones the builder most needs.
const TRIAGE_LIMIT = 20;

/** Decide whether a changed pull request needs the builder, with each new comment triaged. */
async function judgeWake(
  snapshot: PullRequestSnapshot,
  before: PullRequestSnapshot | undefined,
): Promise<{ wake: Wake; triaged: NewComment[] }> {
  const triaged = await triageComments(newComments(snapshot, before));
  const reviews = newReviews(snapshot, before);

  // Talk that asks nothing, on facts that did not move, needs no second opinion.
  if (
    before !== undefined &&
    triaged.length > 0 &&
    reviews.length === 0 &&
    triaged.every((comment) => comment.kind !== undefined && quietKinds.has(comment.kind)) &&
    sameFacts(snapshot, before)
  )
    return { wake: "idle", triaged };

  const wake = await decide({
    site: "pull-request-wake",
    state: {
      ci: snapshot.ci,
      failingChecks: snapshot.failingChecks.map((check) => ({ name: check.name })),
      approval: snapshot.approval.state,
      mergeState: snapshot.mergeState,
      newComments: triaged.map(({ id: _, ...comment }) => comment),
      newReviews: reviews.map(({ user, state, body }) => ({ user, state, body })),
    } satisfies PullRequestWakeState,
    question: pullRequestWake,
    cutoff: CUTOFF,
  });
  return { wake: wake.confident ? wake.answer.choice : "builder", triaged };
}

/** Label each comment in one Jev call; a label below the cutoff is left off. */
async function triageComments(comments: NewComment[]): Promise<NewComment[]> {
  if (comments.length === 0) return [];
  const { answers } = await askJev({
    model: jevModel,
    site: "comment-triage",
    state: {
      comments: comments.map(({ id, user, body, path }) => ({
        id,
        user,
        body,
        path: path ?? null,
      })),
    },
    questions: Object.fromEntries(
      comments.map((comment) => [`c${comment.id}`, commentKind(comment.id)]),
    ),
  });
  return comments.map((comment) => {
    const answer = answers[`c${comment.id}`];
    return answer !== undefined && answer.confidence >= CUTOFF
      ? { ...comment, kind: answer.choice }
      : comment;
  });
}

function newComments(
  snapshot: PullRequestSnapshot,
  before: PullRequestSnapshot | undefined,
): NewComment[] {
  const seen = new Set<string>();
  for (const comment of before?.conversationComments ?? [])
    seen.add(`${comment.id}@${comment.updatedAt}`);
  for (const thread of before?.reviewThreads ?? [])
    for (const comment of thread.comments) seen.add(`${comment.id}@${comment.updatedAt}`);

  const conversation = snapshot.conversationComments
    .filter((comment) => !seen.has(`${comment.id}@${comment.updatedAt}`))
    .map((comment) => ({
      at: comment.updatedAt,
      id: comment.id,
      user: comment.user,
      body: comment.body,
    }));
  const inline = snapshot.reviewThreads.flatMap((thread) =>
    thread.comments
      .filter((comment) => !seen.has(`${comment.id}@${comment.updatedAt}`))
      .map((comment) => ({
        at: comment.updatedAt,
        id: comment.id,
        user: comment.user,
        body: comment.body,
        path: comment.path,
      })),
  );
  return [...conversation, ...inline]
    .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
    .slice(0, TRIAGE_LIMIT)
    .reverse()
    .map(({ at: _, ...comment }) => comment);
}

function newReviews(snapshot: PullRequestSnapshot, before: PullRequestSnapshot | undefined) {
  const seen = new Set((before?.reviews ?? []).map((review) => review.id));
  return snapshot.reviews.filter((review) => !seen.has(review.id));
}

function sameFacts(snapshot: PullRequestSnapshot, before: PullRequestSnapshot): boolean {
  return (
    snapshot.headSha === before.headSha &&
    snapshot.ci === before.ci &&
    snapshot.mergeState === before.mergeState &&
    snapshot.draft === before.draft &&
    snapshot.approval.state === before.approval.state &&
    [...snapshot.labels].sort().join("\n") === [...before.labels].sort().join("\n")
  );
}

// An unresolved local/publication state must never be pushed as a side effect
// of stopping. Keep it available for the person taking over.
function maintenanceStopped(delivery: Delivery, pr: PullRequestRef, reason: string): never {
  throw new DeliveryStopped(
    `jigs stopped pull request maintenance for ${delivery.task.key}.`,
    [
      reason,
      `Unfinished pull request: https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
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
    retained.push(
      `Could not push the branch: ${String(error)}. Recover the work from ${delivery.worktree.path}.`,
    );
  });
  throw new DeliveryStopped(reason, retained, delivery.worktree);
}
