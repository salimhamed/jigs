import { test } from "vitest";
import { evalsConfigured, runEvalSet } from "../src/evals/index.ts";
import { ticketReply, ticketReplyState } from "../src/workflow/linear/decisions.ts";
import type { Halt } from "../src/workflow/linear/halt-for-human.ts";

const retryPolicy: Halt = {
  headline: "jigs paused work on **AGE-41** and needs your answers before it writes any code.",
  where: "ticket review",
  questions: [
    { question: "Should failed webhook deliveries be retried, and how many times?" },
    { question: "Should retries use exponential backoff or a fixed delay?" },
  ],
  onReply: "continue",
};

const brokenLogin: Halt = {
  headline: "jigs stopped because the agent could not log in to Linear.",
  where: "builder",
  notes: ["Run `jigs doctor` and fix the Linear credential, then reply here to retry."],
  onReply: "retry",
};

test.skipIf(!evalsConfigured())("ticket-reply", async () => {
  await runEvalSet({
    site: "ticket-reply",
    rule: { question: ticketReply, whenUnsure: true },
    cases: [
      {
        name: "direct answer to both questions",
        state: ticketReplyState(
          retryPolicy,
          "Retry up to 5 times with exponential backoff, capped at 10 minutes.",
        ),
        expected: true,
      },
      {
        name: "plus one",
        state: ticketReplyState(retryPolicy, "+1"),
        expected: false,
      },
      {
        name: "pings someone else",
        state: ticketReplyState(
          retryPolicy,
          "@dana you know the webhook side better, can you answer this?",
        ),
        expected: false,
      },
      {
        name: "tells the agent to use its judgement",
        state: ticketReplyState(retryPolicy, "Whatever you think is sensible, go ahead."),
        expected: true,
      },
      {
        name: "status chatter",
        state: ticketReplyState(retryPolicy, "Moving this to next sprint's board."),
        expected: false,
      },
      {
        name: "credential fixed, asks to retry",
        state: ticketReplyState(brokenLogin, "Fixed the token, try again."),
        expected: true,
      },
      {
        name: "acknowledges without fixing",
        state: ticketReplyState(brokenLogin, "Thanks, will look at this tomorrow."),
        expected: false,
      },
      {
        name: "answers one question and defers the other",
        state: ticketReplyState(
          retryPolicy,
          "Yes, retry 3 times. Pick whichever backoff you like.",
        ),
        expected: true,
      },
    ],
  });
});
