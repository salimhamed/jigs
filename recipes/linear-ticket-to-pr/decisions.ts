// The Jev decisions the workflow body makes: how big a ticket is, and what a failure means.

import { choice, score } from "@jigs-ai/jigs";

/** The ticket and its implementation brief, as Jev sizes them. */
export type TicketSizeState = {
  ticket: string;
  brief: string;
};

/** Asked once, after ticket review, to pick agents and budgets. */
export const ticketSize = score(
  "How much work is it for an AI coding agent to implement this ticket and its brief in one pull request?",
  [
    "Trivial: a typo, copy, config value or one-line fix",
    "Small: a focused change to one area with obvious tests",
    "Medium: several files or a new behaviour that needs design care",
    "Large: cross-cutting, risky, or touching many modules",
  ],
);

/** Size levels, as `ticketSize` numbers them. */
export const SMALL = 1;

/** A failure the delivery phases did not handle themselves. */
export type FailureState = {
  phase: string;
  attempt: number;
  name: string;
  message: string;
  hint: string | null;
};

/** Asked when a phase throws anything other than DeliveryStopped. */
export const failureTriage = choice(
  "A phase of an automated ticket-to-pull-request workflow failed with this error. What kind of failure is it?",
  {
    transient:
      "Likely to pass on a retry: a network error, timeout, rate limit, 5xx response or a briefly unavailable service",
    "needs-human":
      "A person must fix something outside the code first: missing credentials or permissions, a deleted branch or repository, exhausted quota, or a tool that is not installed",
    bug: "A defect in the workflow or its library: a type error, failed invariant, or unexpected state that a retry would repeat",
  },
);
