import { z } from "zod";
import { haltQuestionSchema } from "../human/questions.ts";
import type { TicketClaim } from "./claim.ts";

// strictObject so the harness's native structured output carries
// additionalProperties:false and a malformed verdict throws at the
// parse in the workflow rather than degrading into a guess.
/**
 * Structured verdict returned by the agent that reviews a ticket before work starts.
 *
 * @group Linear tickets
 */
export const ticketReviewVerdictSchema = z.strictObject({
  verdict: z.enum(["proceed", "needs-human"]),
  brief: z.string().min(1),
  // What the ticket is about, in plain words, for whoever reads the comment.
  about: z.string(),
  questions: z.array(haltQuestionSchema),
  assumptions: z.array(z.string()),
});

/**
 * A comment jigs posts on the ticket that asks for nothing and suspends
 * nothing. It carries its own words, the way a halt does, so the
 * renderer owns the layout and every caller owns what it says.
 *
 * @group Linear tickets
 */
export type TicketNote = {
  /** One plain sentence naming what jigs is about to do, or has stopped doing. */
  headline: string;
  /** The bullet lines under it. */
  notes: string[];
  /** What the reader should do with it. */
  closing: string;
  /**
   * More people to mention, by Linear email, beyond the operator (or the
   * creator) and the assignee. Each person is named once; an email no Linear
   * user has is skipped with a warning.
   */
  mention?: string[] | undefined;
};

/**
 * Posting a note on the ticket that asks for nothing and suspends nothing.
 * Declared here rather than written as `typeof postTicketNote` for the same
 * reason the halt's step contracts are: the routine that calls the step owns the contract.
 */
export type PostTicketNote = (request: {
  installationName: string;
  issueId: string;
  note: TicketNote;
}) => Promise<{ commentId: string }>;

/**
 * Post a note on a claimed ticket and record its comment on the claim, so a
 * later halt in this run never mistakes it for a human's reply.
 */
export async function noteOnTicket(
  claim: TicketClaim,
  note: TicketNote,
  deps: { postTicketNote: PostTicketNote },
): Promise<void> {
  // Destructured for the same reason haltForHuman destructures its steps.
  const { postTicketNote } = deps;
  const { installationName, issueId } = claim;
  const { commentId } = await postTicketNote({ installationName, issueId, note });
  claim.postedCommentIds.push(commentId);
}
