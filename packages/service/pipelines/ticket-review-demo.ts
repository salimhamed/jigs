import { claude } from "jigs/steps";
import { z } from "zod";
import { claimTicket } from "../src/suspension/claim";
import { needsHuman } from "../src/suspension/needs-human";
import { ticketReview } from "../src/ticket/review";
import { fetchSnapshot } from "../src/ticket/snapshot";

export const ticketReviewDemoInputs = z.object({
  issueId: z.uuid(),
  cwd: z.string(),
  model: z.string().default("sonnet"),
  // snapshot-only halts on needsHuman without an agent step, so the repro
  // script can drive the two-activation shape end to end in-process.
  mode: z.enum(["review", "snapshot-only"]).default("review"),
});

type TicketReviewDemoInputs = z.output<typeof ticketReviewDemoInputs> & {
  triggerId: string;
};

// Ticket-review acceptance demo. The body — not the jig — owns the
// per-activation snapshot: the fetch before the halt is the launch-time copy,
// and the fetch after it runs in the resume activation, so the resume-time
// copy carries the human's reply while the launch-time one stays on its own
// step record.
export async function ticketReviewDemoPipeline(inputs: TicketReviewDemoInputs) {
  "use workflow";

  const claim = await claimTicket(inputs.issueId);
  const snapshot = await fetchSnapshot(inputs.issueId);
  console.log(
    `[ticket-review-demo] reviewing ${snapshot.identifier} branch=${snapshot.branchName}`,
  );

  if (inputs.mode === "snapshot-only") {
    await needsHuman(claim, "snapshot version demo");
    const resumed = await fetchSnapshot(inputs.issueId);
    return {
      launchComments: snapshot.comments.map((comment) => comment.id),
      resumedComments: resumed.comments.map((comment) => comment.id),
    };
  }

  const review = await ticketReview({
    claim,
    snapshot,
    harness: claude({ model: inputs.model }),
    cwd: inputs.cwd,
  });

  if (review.verdict === "needs-human") {
    const resumed = await fetchSnapshot(inputs.issueId);
    return {
      verdict: review.verdict,
      findings: review.findings,
      brief: review.brief,
      resumedComments: resumed.comments.map((comment) => comment.id),
    };
  }

  return {
    verdict: review.verdict,
    findings: review.findings,
    brief: review.brief,
    snapshot: review.snapshot,
  };
}
