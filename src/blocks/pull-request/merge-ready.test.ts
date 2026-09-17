import { expect, test } from "vitest";
import type { PrSnapshot } from "../../providers/github.ts";
import { classifyPrState } from "./gate.ts";
import { markBody } from "./marker.ts";
import {
  approvalState,
  isApprovalSatisfied,
  isPullRequestMergeReady,
  mergeRefusal,
} from "./merge-ready.ts";
import type { ApprovalSignal } from "./policy.ts";

const SCOPE = "ship/AGE-402";
const REVIEW: ApprovalSignal = { kind: "review" };
const LABEL: ApprovalSignal = { kind: "label", name: "jigs:approved" };

const snapshot: PrSnapshot = {
  state: "open",
  merged: false,
  draft: false,
  mergeState: "clean",
  labels: [],
  mergeCommitSha: null,
  headSha: "new",
  reviewThreads: [],
  conversationComments: [],
  ci: "green",
  failingChecks: [],
  reviews: [
    { id: 1, state: "APPROVED", body: "", user: "reviewer", submittedAt: "1", commitSha: "new" },
  ],
};

test("GitHub's merge state decides everything it covers", () => {
  expect(isPullRequestMergeReady(snapshot, REVIEW)).toBe(true);
  // Conflicts, failing required checks and missing required reviews all reach
  // jigs as one of these, and none of them is `clean`.
  for (const mergeState of ["dirty", "blocked", "behind", "unstable", "draft", "has_hooks"]) {
    expect(isPullRequestMergeReady({ ...snapshot, mergeState }, REVIEW)).toBe(false);
  }
});

test("a merge state GitHub has not computed yet is not a merge", () => {
  expect(isPullRequestMergeReady({ ...snapshot, mergeState: "unknown" }, REVIEW)).toBe(false);
});

test("a clean pull request with no build is not ready, whatever GitHub says", () => {
  // A repository that requires no checks is `clean` with nothing run at all,
  // including in the seconds before CI registers, so `clean` alone would merge
  // a label-approved pull request ahead of its own build.
  expect(isPullRequestMergeReady({ ...snapshot, ci: "pending" }, REVIEW)).toBe(false);
  expect(isPullRequestMergeReady({ ...snapshot, ci: "red" }, REVIEW)).toBe(false);
  const labelled = { ...snapshot, reviews: [], labels: ["jigs:approved"], ci: "pending" as const };
  expect(isPullRequestMergeReady(labelled, LABEL)).toBe(false);
  expect(classifyPrState(labelled, SCOPE, LABEL).wakes).toEqual([]);
});

test("a draft, a closed and an already merged pull request are never ready", () => {
  expect(isPullRequestMergeReady({ ...snapshot, draft: true }, REVIEW)).toBe(false);
  expect(isPullRequestMergeReady({ ...snapshot, state: "closed" }, REVIEW)).toBe(false);
  expect(isPullRequestMergeReady({ ...snapshot, merged: true }, REVIEW)).toBe(false);
});

test("a review approval names a commit, so a push withdraws it", () => {
  expect(isApprovalSatisfied(snapshot, REVIEW)).toBe(true);
  expect(isApprovalSatisfied({ ...snapshot, headSha: "later" }, REVIEW)).toBe(false);
  expect(isApprovalSatisfied({ ...snapshot, reviews: [] }, REVIEW)).toBe(false);
});

// The refusal is what an operator reads on a parked pull request, so an
// approval that named an earlier commit says so rather than reading as one
// nobody ever gave.
test("an unmet approval names which of the four things is missing", () => {
  const refusalFor = (patch: Partial<PrSnapshot>, signal: ApprovalSignal = REVIEW) =>
    mergeRefusal({ ...snapshot, ...patch }, "new", signal)?.reason;
  const approval = snapshot.reviews[0];
  if (approval === undefined) throw new Error("Missing fixture approval");
  expect(approvalState(snapshot, REVIEW)).toBe("approved");
  expect(refusalFor({ reviews: [] })).toBe("no approving review yet");
  expect(refusalFor({ reviews: [{ ...approval, commitSha: "older" }] })).toBe(
    "the approval does not cover new",
  );
  expect(refusalFor({ reviews: [{ ...approval, state: "CHANGES_REQUESTED" }] })).toBe(
    "a review requests changes",
  );
  expect(refusalFor({ reviews: [] }, LABEL)).toBe(
    "the jigs:approved label is not on the pull request",
  );
});

test("latest effective reviewer decision supersedes historical approvals", () => {
  const approval = snapshot.reviews[0];
  if (approval === undefined) throw new Error("Missing fixture approval");
  const withReviews = (reviews: PrSnapshot["reviews"]) => ({ ...snapshot, reviews });
  expect(
    isApprovalSatisfied(
      withReviews([approval, { ...approval, id: 2, submittedAt: "2", state: "CHANGES_REQUESTED" }]),
      REVIEW,
    ),
  ).toBe(false);
  expect(
    isApprovalSatisfied(
      withReviews([{ ...approval, id: 2, submittedAt: "2", state: "DISMISSED" }, approval]),
      REVIEW,
    ),
  ).toBe(false);
  expect(
    isApprovalSatisfied(
      withReviews([approval, { ...approval, id: 2, user: "another", state: "CHANGES_REQUESTED" }]),
      REVIEW,
    ),
  ).toBe(false);
});

test("a label approval is the pull request's, not a commit's, so it survives a push", () => {
  const labelled = { ...snapshot, reviews: [], labels: ["jigs:approved"] };
  expect(isApprovalSatisfied(labelled, LABEL)).toBe(true);
  expect(isApprovalSatisfied({ ...labelled, headSha: "later" }, LABEL)).toBe(true);
  expect(isApprovalSatisfied({ ...labelled, labels: ["needs-review"] }, LABEL)).toBe(false);
  // The two signals are independent: neither stands in for the other.
  expect(isApprovalSatisfied(labelled, REVIEW)).toBe(false);
  expect(isApprovalSatisfied(snapshot, LABEL)).toBe(false);
});

test("the configured signal is the one the gate classifies with", () => {
  const labelled: PrSnapshot = { ...snapshot, reviews: [], labels: ["jigs:approved"] };
  expect(classifyPrState(labelled, SCOPE, REVIEW).wakes).toEqual([]);
  expect(classifyPrState(labelled, SCOPE, LABEL).wakes).toEqual([
    { kind: "merge-ready", headSha: "new", retryNoted: false },
  ]);
});

test("a pull request GitHub is not ready to merge becomes merge-ready when it is", () => {
  expect(classifyPrState({ ...snapshot, mergeState: "unstable" }, SCOPE, REVIEW).wakes).toEqual([]);
  expect(classifyPrState(snapshot, SCOPE, REVIEW).wakes).toEqual([
    { kind: "merge-ready", headSha: "new", retryNoted: false },
  ]);
});

test("closed snapshots yield no agent or merge work", () => {
  expect(classifyPrState({ ...snapshot, state: "closed", ci: "red" }, SCOPE, REVIEW).wakes).toEqual(
    [{ kind: "closed", merged: false }],
  );
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
  expect(classifyPrState(stoodDown, SCOPE, REVIEW).wakes).toEqual([]);
  // A push moves the head, and the approval of that new head is new work.
  expect(
    classifyPrState(
      {
        ...stoodDown,
        headSha: "newer",
        reviews: stoodDown.reviews.map((review) => ({ ...review, commitSha: "newer" })),
      },
      SCOPE,
      REVIEW,
    ).wakes,
  ).toEqual([{ kind: "merge-ready", headSha: "newer", retryNoted: false }]);
});

test("a refusal jigs can wait out is kept apart from one only a new commit fixes", () => {
  const refusal = (patch: Partial<PrSnapshot>, head = "new") =>
    mergeRefusal({ ...snapshot, ...patch }, head, REVIEW);
  expect(refusal({})).toBeNull();
  for (const mergeState of ["unstable", "blocked", "behind", "unknown", "has_hooks"]) {
    expect(refusal({ mergeState })).toMatchObject({ transient: true });
  }
  expect(refusal({ ci: "pending" })).toMatchObject({ transient: true });
  expect(refusal({ ci: "red" })).toMatchObject({ transient: true });
  // Approving again is the whole recovery, and it names this same commit.
  expect(refusal({ reviews: [] })).toMatchObject({ transient: true });
  expect(refusal({ draft: true })).toMatchObject({ transient: true });
  expect(refusal({}, "old")).toMatchObject({
    transient: true,
    reason: expect.stringContaining("head moved"),
  });

  // Nothing a later wake reads changes any of these on this commit.
  expect(refusal({ mergeState: "dirty" })).toMatchObject({ transient: false });
  expect(refusal({ state: "closed" })).toMatchObject({ transient: false });
});

test("a merge jigs will retry leaves the head merge-ready, and is only noted once", () => {
  const noted = (reason: "merge" | "merge-retry"): PrSnapshot => ({
    ...snapshot,
    conversationComments: [
      {
        id: 1,
        body: markBody("I could not merge this pull request yet.", [
          { scope: SCOPE, run: "wrun_RUN", kind: "status", reason, source: "new" },
        ]),
        user: "salim",
        userType: "User",
        createdAt: "1",
        updatedAt: "1",
      },
    ],
  });
  expect(classifyPrState(noted("merge-retry"), SCOPE, REVIEW).wakes).toEqual([
    { kind: "merge-ready", headSha: "new", retryNoted: true },
  ]);
  expect(classifyPrState(noted("merge"), SCOPE, REVIEW).wakes).toEqual([]);
});
