// The Jev questions the Linear routines ask. They live together so the evals
// ask exactly the words the routines do.

import { choice, yesNo } from "../agents/jev.ts";
import type { HaltQuestion } from "../human/questions.ts";
import type { Halt } from "./halt-for-human.ts";

/**
 * The confidence a Linear decision needs before it changes what a routine does.
 *
 * @group Decision models
 */
export const LINEAR_DECISION_CUTOFF = 0.9;

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

/**
 * Whether a ticket is ready for an agent to plan, and the main reason when it is not.
 *
 * @group Decision models
 */
export const ticketReadiness = choice(
  "A software agent is about to implement this ticket without talking to anyone. " +
    "Is it ready, and if not, what is the main thing missing?",
  {
    ready: "Clear enough to implement: the goal and what done looks like can be worked out",
    "no-acceptance-criteria": "No way to tell when the work is done: the goal or outcome is vague",
    "missing-reproduction":
      "A bug report without the steps, inputs or error needed to reproduce it",
    "conflicting-requirements": "The ticket asks for things that contradict each other",
    "too-large":
      "Several independent features or a project's worth of work, too much for one pull request",
  },
);

/** A reason {@link ticketReadiness} can give for a ticket that is not ready. */
export type NotReadyReason = Exclude<keyof typeof ticketReadiness.options, "ready">;

/** The fixed question jigs asks on the ticket for each not-ready reason. */
export const notReadyQuestions: Record<NotReadyReason, HaltQuestion> = {
  "no-acceptance-criteria": {
    question: "How will we know this ticket is done?",
    context:
      "List the outcome you expect, or the checks a reviewer should make. jigs will not start without one.",
  },
  "missing-reproduction": {
    question: "How can the problem be reproduced?",
    context:
      "Give the steps, the input, and what happens compared with what should happen. An error message or log line helps.",
  },
  "conflicting-requirements": {
    question: "Parts of this ticket contradict each other. Which should win?",
    context: "Edit the ticket so it asks for one consistent outcome, or say which part to follow.",
  },
  "too-large": {
    question: "This looks like more than one pull request of work. Which part should come first?",
    context: "Split the ticket, or name the one piece jigs should do now.",
  },
};
