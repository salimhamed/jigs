// The Jev questions the Linear routines ask, kept apart so the evals ask exactly
// the words the routines do.

import { yesNo } from "../agents/jev.ts";
import type { Halt } from "./halt-for-human.ts";

/**
 * Whether a ticket comment answers the question a halt asked.
 *
 * @group Decision models
 */
export const ticketReply = yesNo(
  "A software agent paused and asked the people on a ticket the question in `asked`. " +
    "Does the comment in `reply` answer it, or tell the agent how to continue? " +
    "Answer no for acknowledgements, +1s, mentions of other people, status chatter, or comments about something else.",
);

/** What {@link ticketReply} is asked about. */
export type TicketReplyState = {
  asked: { headline: string; questions: string[]; notes: string[] };
  reply: string;
};

/** The evidence for {@link ticketReply}: the halt's words and the comment. */
export function ticketReplyState(halt: Halt, reply: string): TicketReplyState {
  return {
    asked: {
      headline: halt.headline,
      questions: (halt.questions ?? []).map((question) => question.question),
      notes: halt.notes ?? [],
    },
    reply,
  };
}
