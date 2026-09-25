// Deliver one work item in three phases, each a plain function the workflow
// calls in order: build and review until approved, publish, follow the pull
// request until it merges. A delivery that stops short pushes its branch and
// throws DeliveryStopped; the workflow decides what to tell whom.

import {
  type Harness,
  isPullRequestMergeReady,
  JigsError,
  type PullRequestRef,
  type TicketNote,
  type Worktree,
} from "@jigs-ai/jigs";
import { z } from "zod";
import { agentSession, runAgent, watchPullRequest } from "#jigs/routines";
import {
  fetchPullRequestState,
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
  /** Every invocation after publication counts, including a decision to wait. */
  prTurns: number;
}

export interface Delivery {
  task: WorkItem;
  worktree: Worktree;
  binding: string;
  builder: Harness;
  reviewer: Harness;
  budget: Budget;
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
        `The work is on branch \`${this.worktree.branch}\`, in the worktree at \`${this.worktree.path}\`.`,
      ],
      closing:
        "Nothing is waiting on a reply here. Start another run to continue, or take the branch over by hand.",
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

export async function followPullRequest(
  delivery: Delivery,
  pr: PullRequestRef,
  builder: BuilderSession,
): Promise<void> {
  const { task, worktree, budget } = delivery;
  const merge = await resolveMergePolicy(delivery.binding);
  let turns = 0;

  for await (const snapshot of watchPullRequest(pr)) {
    if (snapshot.state === "closed") {
      if (snapshot.merged) return;
      return stop(
        delivery,
        `Pull request ${pr.owner}/${pr.repo}#${pr.number} was closed unmerged.`,
        [],
      );
    }

    if (turns >= budget.prTurns) {
      return stop(
        delivery,
        `jigs stopped work on ${task.key} after ${budget.prTurns} pull request agent turn(s).`,
        [`Unfinished pull request: https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`],
      );
    }
    turns += 1;
    const report = await builder.run({
      output: maintenanceReport,
      resume: prompts.maintenance.resume(pr, snapshot),
      fresh: async () =>
        prompts.maintenance.fresh(
          task,
          worktree,
          await readWorktreeDiff(worktree.path, worktree.baseSha),
          pr,
          snapshot,
        ),
    });
    const local = await readBranchState(worktree.path, worktree.baseSha);
    if (local.dirty) {
      return stop(
        delivery,
        `jigs stopped work on ${task.key}: pull request maintenance left uncommitted changes.`,
        [report.summary],
      );
    }
    if (report.status === "needs-human") {
      return stop(
        delivery,
        `jigs stopped work on ${task.key}: pull request maintenance needs human attention.`,
        [report.summary],
      );
    }

    // The agent handles conversation meaning. GitHub approval and checks still
    // govern merging, and a changed head needs a new snapshot and assessment.
    if (
      report.status !== "finished" ||
      merge.by === "human" ||
      local.headSha !== snapshot.headSha ||
      !isPullRequestMergeReady(snapshot, merge.approval)
    )
      continue;

    // The agent may have posted, or a person may have added feedback during
    // its turn. Let the watcher deliver those facts before considering a merge.
    const current = await fetchPullRequestState(pr);
    if (facts(current) !== facts(snapshot)) continue;

    const result = await mergePullRequest(pr, snapshot.headSha, merge).catch((error: unknown) => ({
      merged: false as const,
      reason: String(error),
      transient: true,
    }));
    if (result.merged) return;
    return stop(delivery, `jigs could not merge the pull request for ${task.key}.`, [
      result.reason,
    ]);
  }

  throw new JigsError(
    `the pull request watch for ${pr.owner}/${pr.repo}#${pr.number} ended without a close`,
  );
}

// GitHub collections can arrive in a different order without new activity.
function facts(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(facts).sort().join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${facts(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// A delivery that stops short pushes first, so the commits outlive the
// worktree, then throws with what is still open.
async function stop(delivery: Delivery, reason: string, findings: string[]): Promise<never> {
  const retained = [...findings];
  await pushBranch(delivery.worktree.path, delivery.worktree.branch).catch((error: unknown) => {
    retained.push(
      `Could not push the branch: ${String(error)}. Recover the work from ${delivery.worktree.path}.`,
    );
  });
  throw new DeliveryStopped(reason, retained, delivery.worktree);
}
