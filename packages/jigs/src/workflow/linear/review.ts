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
 * A note a ticket run posts in its Linear agent session that asks for nothing
 * and suspends nothing. It carries its own words, the way a halt does, so the
 * renderer owns the layout and every caller owns what it says.
 *
 * @remarks
 * Linear marks a session stale after about 30 minutes with no activity, and a
 * stale session hides its Stop button. Before a long quiet wait on people, such
 * as a pull request waiting for review, post a note with `run: "waiting"`.
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
  /**
   * What the run does after this note; omitted, it keeps working.
   *
   * @remarks
   * `"ended"` is the run's final message, success or not; Linear shows the
   * session as finished. Set it on every way out of the run. `"waiting"` shows the session as awaiting input, which never goes
   * stale but shows no Stop button. The run does not read replies to a waiting
   * note, so say in it where people act and how to stop the run.
   */
  run?: "waiting" | "ended" | undefined;
};

/**
 * Posting a note in the run's Linear agent session. Declared here rather than
 * written as `typeof postTicketNote` for the same reason the halt's step
 * contract is: the routine that calls the step owns the contract.
 */
export type PostTicketNote = (request: {
  installationName: string;
  issueId: string;
  sessionId: string;
  note: TicketNote;
}) => Promise<void>;

/** Post a note in a claimed ticket's Linear agent session. */
export async function noteOnTicket(
  claim: TicketClaim,
  note: TicketNote,
  deps: { postTicketNote: PostTicketNote },
): Promise<void> {
  // Destructured for the same reason haltForHuman destructures its steps.
  const { postTicketNote } = deps;
  const { installationName, issueId, sessionId } = claim;
  await postTicketNote({ installationName, issueId, sessionId, note });
}
