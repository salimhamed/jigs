// Deliver one work item in three phases, each a plain function the workflow
// calls in order: build and review until approved, publish, follow the pull
// request until it merges. A delivery that stops short pushes its branch and
// throws DeliveryStopped; the workflow decides what to tell whom.

import {
  defaultPullRequestScope,
  type Harness,
  JigsError,
  type PullRequestRef,
  renderChecks,
  type ThreadAnswers,
  type TicketNote,
  type Worktree,
} from "@jigs-ai/jigs";
import { z } from "zod";
import {
  agentSession,
  postPullRequestNote,
  postReviewAnswers,
  pullRequestGate,
  runAgent,
} from "#jigs/routines";
import {
  mergePullRequest,
  openPullRequest,
  pushApprovedChange,
  pushBranch,
  readBranchState,
  readWorktreeDiff,
  registerResource,
  resolveMergePolicy,
  resolveRepository,
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
  ciFixes: number;
  revisionRounds: number;
}

export interface Delivery {
  task: WorkItem;
  worktree: Worktree;
  binding: string;
  builder: Harness;
  reviewer: Harness;
  /** Repairs CI and answers review threads after publication. */
  fixer: Harness;
  budget: Budget;
}

export interface Approved {
  /** The commit the reviewer approved, and the only one publication pushes. */
  reviewedCommit: string;
  ledger: ReviewRound[];
}

/** Thrown when a delivery stops short. The branch is already pushed. */
export class DeliveryStopped extends JigsError {
  readonly findings: string[];
  readonly worktree: Worktree;

  constructor(message: string, findings: string[], worktree: Worktree) {
    super(message, findings.length === 0 ? undefined : findings.join("\n"));
    this.name = "DeliveryStopped";
    this.findings = findings;
    this.worktree = worktree;
  }

  /** What to tell a person: what is still open and where the work is. */
  note(): TicketNote {
    return {
      headline: this.message,
      notes: [
        ...this.findings,
        `The work is on branch \`${this.worktree.branch}\`, pushed, in the worktree at \`${this.worktree.path}\`.`,
      ],
      closing:
        "Nothing is waiting on a reply here. Start another run to continue, or take the branch over by hand.",
    };
  }
}

// threadId null answers the pull request conversation: a review body has no
// thread root to reply into.
const threadAnswers = z.strictObject({
  answers: z.array(
    z.strictObject({ threadId: z.number().int().nullable(), body: z.string().min(1) }),
  ),
  commitExplanation: z.string().min(1).nullable(),
}) satisfies z.ZodType<ThreadAnswers>;

// ---- phase 1: build and review until approved ------------------------------

export async function implementAndReview(delivery: Delivery): Promise<Approved> {
  const { task, worktree, budget } = delivery;
  const cwd = worktree.path;
  const builderSession = agentSession({ name: "builder", harness: delivery.builder, cwd });
  const reviewerSession = agentSession({ name: "reviewer", harness: delivery.reviewer, cwd });
  const diff = () => readWorktreeDiff(cwd, worktree.baseSha);
  const ledger: ReviewRound[] = [];
  let findings: ReviewFinding[] = [];

  for (let round = 1; round <= budget.reviewRounds; round++) {
    const report = await builderSession.run({
      output: implementationReport,
      resume: prompts.implementation.resume(findings),
      fresh: async () => prompts.implementation.fresh(task, worktree, findings, await diff()),
    });

    const state = await readBranchState(cwd, worktree.baseSha);
    if (state.dirty || state.commits === 0) {
      return stop(delivery, `jigs stopped work on ${task.key} in review round ${round}.`, [
        state.dirty
          ? "The implementation left uncommitted changes; only committed work is reviewed."
          : "The implementation added no commits since the base commit.",
      ]);
    }

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
  await pushApprovedChange(worktree.path, worktree.branch, approved.reviewedCommit);

  const described = await runAgent({
    harness: delivery.builder,
    cwd: worktree.path,
    prompt: prompts.description(
      task,
      worktree,
      await readWorktreeDiff(worktree.path, worktree.baseSha),
    ),
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
    repo: await resolveRepository(delivery.binding),
    head: worktree.branch,
    base: worktree.defaultBranch,
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

export async function followPullRequest(delivery: Delivery, pr: PullRequestRef): Promise<void> {
  const { task, worktree, budget } = delivery;
  const cwd = worktree.path;
  const merge = await resolveMergePolicy(delivery.binding);
  const scope = defaultPullRequestScope(task.key);
  const fixerSession = agentSession({ name: "fixer", harness: delivery.fixer, cwd });
  const diff = () => readWorktreeDiff(cwd, worktree.baseSha);
  const spent = { ciFixes: 0, revisionRounds: 0 };

  for await (const wake of pullRequestGate(pr, { scope, approval: merge.approval, worktree })) {
    if (wake.kind === "closed") {
      if (wake.merged) return;
      return stop(
        delivery,
        `Pull request ${pr.owner}/${pr.repo}#${pr.number} was closed unmerged.`,
        [],
      );
    }

    if (wake.kind === "merge-ready") {
      if (merge.by === "human") continue;
      // A thrown merge is unclassified: it may pass on a later wake.
      const result = await mergePullRequest(pr, wake.headSha, merge).catch((error: unknown) => ({
        merged: false as const,
        reason: String(error),
        transient: true,
      }));
      if (result.merged) return;
      // A "merge" note stands this commit down; "merge-retry" keeps it merge-ready.
      await postPullRequestNote({
        pr,
        scope,
        reason: result.transient ? "merge-retry" : "merge",
        headSha: wake.headSha,
        body: result.transient
          ? `I could not merge this pull request yet: ${result.reason}. I will try again when GitHub reports a change.`
          : `I could not merge this pull request: ${result.reason}. It needs a new commit or a change to the repository.`,
      });
      continue;
    }

    if (wake.kind === "ci-red") {
      if (spent.ciFixes === budget.ciFixes) {
        return stop(
          delivery,
          `jigs stopped work on ${task.key} after ${budget.ciFixes} CI repair attempt(s).`,
          wake.failing.map((check) => `${check.name}: ${check.conclusion}`),
        );
      }
      spent.ciFixes += 1;
      await fixerSession.run({
        resume: prompts.ciRepair.resume(wake.failing),
        fresh: async () => prompts.ciRepair.fresh(task, worktree, await diff(), wake.failing),
      });
      const state = await readBranchState(cwd, worktree.baseSha);
      if (state.headSha === wake.headSha || state.dirty) {
        // Marks this red head as given up on, so a later run does not spend its budget on it.
        await postPullRequestNote({
          pr,
          scope,
          reason: "ci",
          headSha: wake.headSha,
          body: `I could not repair the failing checks on ${wake.headSha}.\n\n${renderChecks(wake.failing)}`,
        });
        return stop(
          delivery,
          `jigs stopped work on ${task.key}: the CI repair produced no new clean commit.`,
          [],
        );
      }
      await pushBranch(cwd, worktree.branch);
      continue;
    }

    // wake.kind === "review-comments"
    if (spent.revisionRounds === budget.revisionRounds) {
      return stop(
        delivery,
        `jigs stopped work on ${task.key} after ${budget.revisionRounds} review revision round(s).`,
        [wake.body ?? "Address the pull request review threads."],
      );
    }
    spent.revisionRounds += 1;
    const before = await readBranchState(cwd, worktree.baseSha);
    const answers = await fixerSession.run({
      output: threadAnswers,
      resume: prompts.revision.resume(wake.threads, wake.body),
      fresh: async () =>
        prompts.revision.fresh(task, worktree, await diff(), wake.threads, wake.body),
    });
    const after = await readBranchState(cwd, worktree.baseSha);
    if (after.dirty) throw new JigsError("Pull request revision left uncommitted changes");
    await pushBranch(cwd, worktree.branch);
    // Only a round that pushed a commit gets an explanation comment naming it.
    const committedSha = after.headSha === before.headSha ? undefined : after.headSha;
    await postReviewAnswers({ pr, scope, answers, committedSha, threads: wake.threads });
  }

  throw new JigsError(
    `the pull request gate for ${pr.owner}/${pr.repo}#${pr.number} ended without a close`,
  );
}

// A delivery that stops short pushes first, so the commits outlive the
// worktree, then throws with what is still open.
async function stop(delivery: Delivery, reason: string, findings: string[]): Promise<never> {
  await pushBranch(delivery.worktree.path, delivery.worktree.branch);
  throw new DeliveryStopped(reason, findings, delivery.worktree);
}
