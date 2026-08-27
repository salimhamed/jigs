import { claude } from "jigs/steps";
import { z } from "zod";
import { claimTicket } from "../src/suspension/claim";
import { ticketReview } from "../src/ticket/review";
import { fetchSnapshot } from "../src/ticket/snapshot";

export const ticketReviewDemoInputs = z.object({
  issueId: z.uuid(),
  cwd: z.string(),
  model: z.string().default("sonnet"),
});

type TicketReviewDemoInputs = z.output<typeof ticketReviewDemoInputs> & {
  triggerId: string;
};

// Ticket-review acceptance demo. The body — not the jig — owns the
// per-activation snapshot: the fetch before the review is the launch-time
// copy, and the fetch after a needs-human halt runs in the resume
// activation, so its version carries the human's reply while version 1 stays
// on the record.
export async function ticketReviewDemoPipeline(inputs: TicketReviewDemoInputs) {
  "use workflow";

  const claim = await claimTicket(inputs.issueId);
  const snapshot = await fetchSnapshot(inputs.issueId, 1);
  console.log(
    `[ticket-review-demo] reviewing ${snapshot.identifier} branch=${snapshot.branchName}`,
  );

  const review = await ticketReview({
    claim,
    snapshot,
    harness: claude({ model: inputs.model }),
    cwd: inputs.cwd,
  });

  if (review.verdict === "needs-human") {
    const resumed = await fetchSnapshot(inputs.issueId, 2);
    return {
      verdict: review.verdict,
      findings: review.findings,
      brief: review.brief,
      versions: [snapshot.version, resumed.version],
      resumedComments: resumed.comments.length,
    };
  }

  return {
    verdict: review.verdict,
    brief: review.brief,
    snapshot: review.snapshot,
    versions: [snapshot.version],
  };
}
