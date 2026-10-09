import {
  type Harness,
  renderTicketSnapshot,
  type TicketClaim,
  type TicketSnapshot,
  ticketReviewPrompt,
  ticketReviewVerdictSchema,
} from "@jigs-ai/jigs";
import { haltForHuman, noteOnTicket, runAgent } from "#jigs/routines";
import { fetchTicketSnapshot } from "#jigs/steps";

/**
 * What a ticket review hands the builder: the brief plus the snapshot it was written from. The
 * ticket wins wherever the two conflict, so the work is judged against the snapshot, never the
 * brief. `assumptions` is what the review decided for itself; it is posted in the ticket's session
 * so a person can still correct it.
 */
export type TicketHandoff = {
  brief: string;
  snapshot: TicketSnapshot;
  assumptions: string[];
};

/** Review a ticket until it is actionable, asking in its session when a decision is missing. */
export async function reviewTicket(options: {
  claim: TicketClaim;
  snapshot: TicketSnapshot;
  harness: Harness;
  cwd: string;
}): Promise<TicketHandoff> {
  const { claim } = options;
  let snapshot = options.snapshot;

  for (;;) {
    const review = await runAgent({
      harness: options.harness,
      cwd: options.cwd,
      prompt: ticketReviewPrompt({ ticket: renderTicketSnapshot(snapshot) }),
      output: ticketReviewVerdictSchema,
    });
    const { verdict, brief, about, questions, assumptions } = review.output;
    console.log(
      `[reviewTicket] ${snapshot.identifier} verdict=${verdict} questions=${questions.length} assumptions=${assumptions.length}`,
    );
    if (verdict === "proceed") {
      // A note, not a halt: the run keeps going, and a correction now lands on the pull request.
      if (assumptions.length > 0) {
        await noteOnTicket(claim, {
          headline: `Starting work on ${snapshot.identifier}. Before writing code, the reviewer read the ticket and made these assumptions:`,
          notes: assumptions,
          closing:
            "Work is going ahead with these assumptions. To change one, comment on the pull request once it opens.",
        });
      }
      return { brief, snapshot, assumptions };
    }

    // Only the questions reach the session; the brief the next round writes is what the builder reads.
    await haltForHuman(claim, {
      headline: `Work on **${snapshot.identifier}** is paused: your answers are needed before any code is written.`,
      where: "ticket review",
      ...(about === "" ? {} : { about }),
      questions,
      onReply: "continue",
    });
    // Linear stores the question and each reply as threaded comments on the
    // ticket, so the next round reads them in a fresh snapshot.
    snapshot = await fetchTicketSnapshot({
      installationName: claim.installationName,
      issueId: snapshot.id,
    });
  }
}
