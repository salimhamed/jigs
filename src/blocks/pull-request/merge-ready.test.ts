import { expect, test } from "vitest";
import type { PrSnapshot } from "../../providers/github.ts";
import { classifyPrState } from "./gate.ts";
import { markBody } from "./marker.ts";
import { isPullRequestMergeReady } from "./merge-ready.ts";

const SCOPE = "ship/AGE-402";
const snapshot: PrSnapshot = {
  state: "open",
  merged: false,
  headSha: "new",
  reviewThreads: [],
  conversationComments: [],
  ci: "green",
  failingChecks: [],
  reviews: [
    { id: 1, state: "APPROVED", body: "", user: "reviewer", submittedAt: "1", commitSha: "new" },
  ],
};

test("only current-head approval with green checks permits merge", () => {
  expect(isPullRequestMergeReady(snapshot)).toBe(true);
  expect(isPullRequestMergeReady({ ...snapshot, ci: "pending" })).toBe(false);
  expect(isPullRequestMergeReady({ ...snapshot, ci: "red" })).toBe(false);
  expect(isPullRequestMergeReady({ ...snapshot, headSha: "later" })).toBe(false);
  expect(isPullRequestMergeReady({ ...snapshot, state: "closed" })).toBe(false);
});

test("latest effective reviewer decision supersedes historical approvals", () => {
  const approval = snapshot.reviews[0];
  if (approval === undefined) throw new Error("Missing fixture approval");
  expect(
    isPullRequestMergeReady({
      ...snapshot,
      reviews: [approval, { ...approval, id: 2, submittedAt: "2", state: "CHANGES_REQUESTED" }],
    }),
  ).toBe(false);
  expect(
    isPullRequestMergeReady({
      ...snapshot,
      reviews: [{ ...approval, id: 2, submittedAt: "2", state: "DISMISSED" }, approval],
    }),
  ).toBe(false);
  expect(
    isPullRequestMergeReady({
      ...snapshot,
      reviews: [approval, { ...approval, id: 2, user: "another", state: "CHANGES_REQUESTED" }],
    }),
  ).toBe(false);
});

test("approval while pending becomes merge-ready when CI later turns green", () => {
  expect(classifyPrState({ ...snapshot, ci: "pending" }, SCOPE).wakes).toEqual([]);
  expect(classifyPrState(snapshot, SCOPE).wakes).toEqual([{ kind: "merge-ready", headSha: "new" }]);
});

test("closed snapshots yield no agent or merge work", () => {
  expect(classifyPrState({ ...snapshot, state: "closed", ci: "red" }, SCOPE).wakes).toEqual([
    { kind: "closed", merged: false },
  ]);
});

test("a stood-down head does not ask to be merged again", () => {
  const stoodDown: PrSnapshot = {
    ...snapshot,
    conversationComments: [
      {
        id: 1,
        body: markBody("I could not merge this pull request.", [
          { scope: SCOPE, run: "wrun_RUN", kind: "status", reason: "merge", source: "new" },
        ]),
        user: "salim",
        userType: "User",
        createdAt: "1",
        updatedAt: "1",
      },
    ],
  };
  expect(classifyPrState(stoodDown, SCOPE).wakes).toEqual([]);
  // A push moves the head, and the approval of that new head is new work.
  expect(
    classifyPrState(
      {
        ...stoodDown,
        headSha: "newer",
        reviews: stoodDown.reviews.map((review) => ({ ...review, commitSha: "newer" })),
      },
      SCOPE,
    ).wakes,
  ).toEqual([{ kind: "merge-ready", headSha: "newer" }]);
});
