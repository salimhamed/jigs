import type { ReviewConvergenceState } from "../recipes/linear-ticket-to-pr/delivery/decisions.ts";
import { reviewConvergence } from "../recipes/linear-ticket-to-pr/delivery/decisions.ts";
import { evalSite } from "./harness.ts";

const round = (
  n: number,
  blocking: string[],
  responses: { finding: string; changed: boolean }[] = [],
) => ({ round: n, blocking, nonBlocking: 0, responses });

const state = (...rounds: ReviewConvergenceState["rounds"]): ReviewConvergenceState => ({
  budget: 4,
  rounds,
});

evalSite("review-convergence", {
  question: reviewConvergence,
  cutoff: 0.9,
  cases: [
    {
      name: "findings shrink and get fixed",
      state: state(
        round(1, ["Missing test for empty cart", "Null check missing in total()"]),
        round(
          2,
          ["Test name is misleading"],
          [
            { finding: "Missing test for empty cart", changed: true },
            { finding: "Null check missing in total()", changed: true },
          ],
        ),
      ),
      expected: 0,
    },
    {
      name: "same finding declined twice",
      state: state(
        round(1, ["Retry loop has no upper bound"]),
        round(
          2,
          ["Retry loop has no upper bound"],
          [{ finding: "Retry loop has no upper bound", changed: false }],
        ),
        round(
          3,
          ["Retry loop has no upper bound"],
          [{ finding: "Retry loop has no upper bound", changed: false }],
        ),
      ),
      expected: 2,
    },
    {
      name: "fix claimed but finding returns",
      state: state(
        round(1, ["Migration drops the users.email index"]),
        round(
          2,
          ["Migration drops the users.email index"],
          [{ finding: "Migration drops the users.email index", changed: true }],
        ),
        round(
          3,
          ["Migration drops the users.email index"],
          [{ finding: "Migration drops the users.email index", changed: true }],
        ),
      ),
      expected: 2,
    },
    {
      name: "new findings each round after fixes",
      state: state(
        round(1, ["Missing auth check on DELETE"]),
        round(
          2,
          ["Error message leaks the user id"],
          [{ finding: "Missing auth check on DELETE", changed: true }],
        ),
      ),
      expected: 0,
    },
    {
      name: "one fixed, one recurring",
      state: state(
        round(1, ["Missing test", "Timeout not configurable"]),
        round(
          2,
          ["Timeout not configurable"],
          [
            { finding: "Missing test", changed: true },
            { finding: "Timeout not configurable", changed: false },
          ],
        ),
      ),
      expected: 1,
    },
    {
      name: "findings grow every round",
      state: state(
        round(1, ["A"]),
        round(2, ["A", "B"], [{ finding: "A", changed: true }]),
        round(
          3,
          ["A", "B", "C"],
          [
            { finding: "A", changed: true },
            { finding: "B", changed: true },
          ],
        ),
      ),
      expected: 2,
    },
  ],
});
