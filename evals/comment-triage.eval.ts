import { test } from "vitest";
import { commentKind } from "../recipes/linear-ticket-to-pr/delivery/decisions.ts";
import { evalsConfigured, runEvalSet } from "../src/evals/index.ts";

// Each case asks about comment 1; other comments are there to be ignored.
const about = (
  body: string,
  user = "dana",
  others: { id: number; user: string; body: string }[] = [],
) => ({
  comments: [
    { id: 1, user, body, path: null },
    ...others.map((other) => ({ ...other, path: null })),
  ],
});

test.skipIf(!evalsConfigured())("comment-triage", async () => {
  await runEvalSet({
    site: "comment-triage",
    rule: { question: commentKind(1), whenUnsure: "question" },
    cases: [
      {
        name: "asks why",
        state: about("Why did you drop the backoff here? Won't this hammer the API?"),
        expected: "question",
      },
      {
        name: "asks for a rename",
        state: about("Please rename `doIt` to `retryCharge`."),
        expected: "change-request",
      },
      { name: "thanks", state: about("Thanks, this reads much better now 🙏"), expected: "praise" },
      {
        name: "coverage bot",
        state: about("## Codecov Report\nAll modified lines are covered.", "codecov[bot]"),
        expected: "automated",
      },
      {
        name: "shares context",
        state: about(
          "FYI the billing team is migrating this table next sprint; no action needed here.",
        ),
        expected: "fyi",
      },
      {
        name: "author answers a question",
        state: about(
          "Good catch: the backoff moved into `withRetry`, which wraps this call. No behaviour change.",
          "builder-bot",
          [{ id: 2, user: "dana", body: "Why did you drop the backoff here?" }],
        ),
        expected: "author-reply",
      },
      {
        name: "question among praise",
        state: about("Does this also cover the EU region?", "sam", [
          { id: 2, user: "dana", body: "Looks great!" },
        ]),
        expected: "question",
      },
      {
        name: "asks for a test",
        state: about("Can you add a test for the empty-cart case before we merge?"),
        expected: "change-request",
      },
    ],
  });
});
