import { claude } from "jigs/steps";
import { z } from "zod";
import { claimTicket } from "../src/suspension/claim";
import { ticketReview } from "../src/ticket/review";
import { ticketSnapshots } from "../src/ticket/snapshot";

export const ticketReviewDemoInputs = z.object({
  issueId: z.uuid(),
  cwd: z.string(),
  model: z.string().default("sonnet"),
});

type TicketReviewDemoInputs = z.output<typeof ticketReviewDemoInputs> & {
  triggerId: string;
};

// Ticket-review acceptance demo. The body — not the jig — owns the
// per-activation snapshot: the refresh before the review is the launch-time
// copy, and the refresh after a needs-human halt runs in the resume
// activation, so its version carries the human's reply while version 1 stays
// on the record.
export async function ticketReviewDemoPipeline(inputs: TicketReviewDemoInputs) {
  "use workflow";

  const claim = await claimTicket(inputs.issueId);
  const tickets = ticketSnapshots(inputs.issueId);
  const snapshot = await tickets.refresh();
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
    const resumed = await tickets.refresh();
    return {
      verdict: review.verdict,
      findings: review.findings,
      brief: review.brief,
      versions: tickets.versions.map((version) => version.version),
      resumedComments: resumed.comments.length,
    };
  }

  return {
    verdict: review.verdict,
    brief: review.brief,
    snapshot: review.snapshot,
    versions: tickets.versions.map((version) => version.version),
  };
}
