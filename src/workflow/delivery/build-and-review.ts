import type { Worktree } from "../workspaces/worktree.ts";
import {
  formats,
  implementationReport,
  type ReviewFinding,
  type ReviewRound,
  reviewVerdict,
  withFormat,
} from "./answers.ts";
import {
  type Delivery,
  type DeliveryPrompts,
  type DeliverySteps,
  withoutLocalPath,
} from "./delivery.ts";

/**
 * The parts of a delivery `buildAndReview` reads.
 *
 * @group Pull request delivery
 */
export type BuildDelivery<W> = Pick<Delivery<W>, "work" | "worktree" | "builder" | "reviewer"> & {
  prompts: Pick<DeliveryPrompts<W>, "build" | "review">;
};

/**
 * What `buildAndReview` needs besides the delivery.
 *
 * @group Pull request delivery
 */
export interface BuildAndReviewOptions {
  /** One round is one build plus one review of what it committed. */
  rounds: number;
}

/**
 * A change the reviewer approved.
 *
 * @group Pull request delivery
 */
export interface Built {
  /** The commit the reviewer approved. Publish exactly this one. */
  reviewedCommit: string;
  /** The non-blocking findings of the approving round, for a person to read. */
  notes: string[];
  ledger: ReviewRound[];
}

/**
 * Why `buildAndReview` stopped without an approved change. Nothing is pushed: committed work stays
 * in the worktree for the workflow to push or leave.
 *
 * @remarks
 * `rounds-exhausted` carries the blocking findings still open. `uncommitted` and `no-commits` mean
 * the builder left uncommitted changes, or committed nothing new, so there was nothing to review.
 *
 * @group Pull request delivery
 */
export interface BuildStopped {
  reason: "rounds-exhausted" | "uncommitted" | "no-commits";
  findings: string[];
  /** The round it stopped in; for `rounds-exhausted`, the last round. */
  round: number;
}

/**
 * Build and review until the reviewer raises no blocking finding, or the rounds run out.
 *
 * @remarks
 * The builder works in the delivery's worktree and commits; the reviewer reviews what it
 * committed. A round is approved when no finding is blocking. Each agent resumes its session from
 * round to round. Nothing is pushed, on approval or on a stop.
 *
 * @group Pull request delivery
 */
export async function buildAndReview<W>(
  delivery: BuildDelivery<W>,
  { rounds }: BuildAndReviewOptions,
  steps: Pick<DeliverySteps, "readBranchState" | "readWorktreeDiff">,
): Promise<Built | { stopped: BuildStopped }> {
  const { work, worktree, prompts } = delivery;
  const diff = () => steps.readWorktreeDiff(worktree);
  const ledger: ReviewRound[] = [];
  let findings: ReviewFinding[] = [];

  for (let round = 1; round <= rounds; round++) {
    const report = await delivery.builder.run({
      output: implementationReport,
      resume: withFormat(prompts.build.resume({ findings }), formats.build),
      fresh: async () =>
        withFormat(
          prompts.build.fresh({ work, worktree, findings, diff: await diff() }),
          formats.build,
        ),
    });

    const state = await steps.readBranchState(worktree, worktree.baseSha);
    if (state.dirty) return stop(worktree, "uncommitted", [], round);
    if (state.commits === 0) return stop(worktree, "no-commits", [], round);

    const current = await diff();
    const verdict = await delivery.reviewer.run({
      output: reviewVerdict,
      resume: withFormat(
        prompts.review.resume({
          headSha: state.headSha,
          diff: current,
          responses: report.responses,
        }),
        formats.review,
      ),
      fresh: withFormat(
        prompts.review.fresh({ work, worktree, headSha: state.headSha, diff: current, ledger }),
        formats.review,
      ),
    });

    findings = verdict.findings;
    const blocking = findings.some((finding) => finding.blocking);
    ledger.push({
      round,
      responses: report.responses,
      verdict: blocking ? "changes-requested" : "approved",
      findings,
    });
    if (!blocking) {
      const notes = findings.map((finding) => withoutLocalPath(worktree, finding.summary));
      return { reviewedCommit: state.headSha, notes, ledger };
    }
  }

  const open = findings.filter((finding) => finding.blocking).map((finding) => finding.summary);
  return stop(worktree, "rounds-exhausted", open, rounds);
}

const stop = (
  worktree: Worktree,
  reason: BuildStopped["reason"],
  findings: string[],
  round: number,
): { stopped: BuildStopped } => ({
  stopped: {
    reason,
    findings: findings.map((finding) => withoutLocalPath(worktree, finding)),
    round,
  },
});
