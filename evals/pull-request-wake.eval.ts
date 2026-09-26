import {
  type PullRequestWakeState,
  pullRequestWake,
} from "../recipes/linear-ticket-to-pr/delivery/decisions.ts";
import { evalSite } from "./harness.ts";

const quiet: PullRequestWakeState = {
  ci: "pending",
  failingChecks: [],
  approval: "none",
  mergeState: "clean",
  newComments: [],
  newReviews: [],
};

evalSite("pull-request-wake", {
  question: pullRequestWake,
  cutoff: 0.9,
  cases: [
    { name: "CI still running, nothing new", state: { ...quiet }, expected: "idle" },
    {
      name: "unit tests failed",
      state: { ...quiet, ci: "red", failingChecks: [{ name: "test (node 24)" }] },
      expected: "builder",
    },
    {
      name: "reviewer requested a rename",
      state: {
        ...quiet,
        ci: "green",
        approval: "changes-requested",
        newReviews: [{ user: "dana", state: "CHANGES_REQUESTED", body: "A couple of nits." }],
        newComments: [
          {
            user: "dana",
            path: "src/billing/retry.ts",
            body: "Please rename `doIt` to `retryCharge`; the current name hides what it does.",
          },
        ],
      },
      expected: "builder",
    },
    {
      name: "approved, green, nothing outstanding",
      state: {
        ...quiet,
        ci: "green",
        approval: "approved",
        newReviews: [{ user: "dana", state: "APPROVED", body: "" }],
      },
      expected: "merge",
    },
    {
      name: "product decision raised in discussion",
      state: {
        ...quiet,
        ci: "green",
        newComments: [
          {
            user: "sam",
            body: "Before this goes further: do we keep the v1 endpoint for existing customers or drop it now? That's a product call, not something to settle in code review.",
          },
        ],
      },
      expected: "human",
    },
    {
      name: "coverage bot report only",
      state: {
        ...quiet,
        ci: "green",
        newComments: [
          {
            user: "codecov[bot]",
            body: "## Codecov Report\nAll modified lines are covered by tests. Project coverage is 91.2% (+0.1%).",
          },
        ],
      },
      expected: "idle",
    },
    {
      name: "praise while CI runs",
      state: {
        ...quiet,
        newComments: [{ user: "dana", body: "Nice, this is much clearer than before 👍" }],
      },
      expected: "idle",
    },
    {
      name: "reviewer asks the author why",
      state: {
        ...quiet,
        ci: "green",
        newComments: [
          {
            user: "dana",
            path: "src/billing/retry.ts",
            body: "Why did you remove the backoff here? Won't this hammer the payment API?",
          },
        ],
      },
      expected: "builder",
    },
    {
      name: "merge conflict with main",
      state: { ...quiet, ci: "green", approval: "approved", mergeState: "dirty" },
      expected: "builder",
    },
  ],
});
