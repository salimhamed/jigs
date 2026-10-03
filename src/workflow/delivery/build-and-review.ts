import {
  formats,
  implementationReport,
  type ReviewFinding,
  type ReviewRound,
  reviewVerdict,
  withFormat,
} from "./answers.ts";
import { claimKey, type Delivery, type DeliverySteps, withoutLocalPath } from "./delivery.ts";

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
 * Why `buildAndReview` stopped without an approved change. The branch was pushed first when it
 * could be; `pushed` says whether it was.
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
  pushed: boolean;
}

/**
 * Build and review until the reviewer raises no blocking finding, or the rounds run out.
 *
 * @remarks
 * The builder works in the delivery's worktree and commits; the reviewer reviews what it
 * committed. A finding's `blocking` flag decides a round, not the verdict the reviewer states.
 * Each agent resumes its session from round to round. Nothing is pushed on approval.
 *
 * @group Pull request delivery
 */
export async function buildAndReview<W>(
  delivery: Delivery<W>,
  { rounds }: BuildAndReviewOptions,
  steps: DeliverySteps,
): Promise<Built | { stopped: BuildStopped }> {
  claimKey(delivery);
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
    if (state.dirty) return stop(delivery, steps, "uncommitted", []);
    if (state.commits === 0) return stop(delivery, steps, "no-commits", []);

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

    // An approval that carries a blocking finding is the reviewer contradicting itself.
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
  return stop(delivery, steps, "rounds-exhausted", open);
}

// The push keeps committed work on the remote for whoever takes it over. Its
// error can name local paths, so it stays in the service log.
async function stop<W>(
  delivery: Delivery<W>,
  steps: DeliverySteps,
  reason: BuildStopped["reason"],
  findings: string[],
): Promise<{ stopped: BuildStopped }> {
  const pushed = await steps.pushBranch(delivery.worktree).then(
    () => true,
    () => false,
  );
  const posted = findings.map((finding) => withoutLocalPath(delivery.worktree, finding));
  return { stopped: { reason, findings: posted, pushed } };
}
