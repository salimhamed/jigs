import { expect, test } from "vitest";
import { classifyPullRequestState } from "./gate.ts";
import { markBody } from "./marker.ts";
import { approvalState, isPullRequestMergeReady, mergeRefusal } from "./merge-ready.ts";
import type { MergeApproval } from "./policy.ts";
import type { PullRequestSnapshot } from "./snapshot.ts";

const SCOPE = "ship/AGE-402";

type Facts = Omit<PullRequestSnapshot, "approval">;

const facts: Facts = {
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

// A snapshot as the fetch step reads it: the facts, and consent read against the signal.
const read = (
  patch: Partial<Facts> = {},
  signal: MergeApproval = "review",
): PullRequestSnapshot => {
  const current = { ...facts, ...patch };
  return { ...current, approval: { signal, state: approvalState(current, signal) } };
};
const snapshot = read();
const approved = (patch: Partial<Facts>, signal: MergeApproval = "review") =>
  approvalState({ ...facts, ...patch }, signal) === "approved";

test("GitHub's merge state decides everything it covers", () => {
  expect(isPullRequestMergeReady(snapshot)).toBe(true);
  // Conflicts, failing required checks and missing required reviews all reach
  // jigs as one of these, and none of them is `clean`.
  for (const mergeState of ["dirty", "blocked", "behind", "unstable", "draft", "has_hooks"]) {
    expect(isPullRequestMergeReady(read({ mergeState }))).toBe(false);
  }
});

test("a merge state GitHub has not computed yet is not a merge", () => {
  expect(isPullRequestMergeReady(read({ mergeState: "unknown" }))).toBe(false);
});

test("a clean pull request with no build is not ready, whatever GitHub says", () => {
  // A repository that requires no checks is `clean` with nothing run at all,
  // including in the seconds before CI registers, so `clean` alone would merge
  // a label-approved pull request ahead of its own build.
  expect(isPullRequestMergeReady(read({ ci: "pending" }))).toBe(false);
  expect(isPullRequestMergeReady(read({ ci: "red" }))).toBe(false);
  const labelled = read({ reviews: [], labels: ["jigs:approved"], ci: "pending" }, "label");
  expect(isPullRequestMergeReady(labelled)).toBe(false);
  expect(classifyPullRequestState(labelled, SCOPE).wakes).toEqual([]);
});

test("a draft, a closed and an already merged pull request are never ready", () => {
  expect(isPullRequestMergeReady(read({ draft: true }))).toBe(false);
  expect(isPullRequestMergeReady(read({ state: "closed" }))).toBe(false);
  expect(isPullRequestMergeReady(read({ merged: true }))).toBe(false);
});

test("a review approval names a commit, so a push withdraws it", () => {
  expect(approved({})).toBe(true);
  expect(approved({ headSha: "later" })).toBe(false);
  expect(approved({ reviews: [] })).toBe(false);
});

// The refusal is what an operator reads on a parked pull request, so an
// approval that named an earlier commit says so rather than reading as one
// nobody ever gave.
test("an unmet approval names which of the four things is missing", () => {
  const refusalFor = (patch: Partial<Facts>, signal: MergeApproval = "review") =>
    mergeRefusal(read(patch, signal), "new")?.reason;
  const approval = facts.reviews[0];
  if (approval === undefined) throw new Error("Missing fixture approval");
  expect(snapshot.approval).toEqual({ signal: "review", state: "approved" });
  expect(refusalFor({ reviews: [] })).toBe("no approving review yet");
  expect(refusalFor({ reviews: [{ ...approval, commitSha: "older" }] })).toBe(
    "the approval does not cover new",
  );
  expect(refusalFor({ reviews: [{ ...approval, state: "CHANGES_REQUESTED" }] })).toBe(
    "a review requests changes",
  );
  expect(refusalFor({ reviews: [] }, "label")).toBe(
    "the jigs:approved label is not on the pull request",
  );
});

test("latest effective reviewer decision supersedes historical approvals", () => {
  const approval = facts.reviews[0];
  if (approval === undefined) throw new Error("Missing fixture approval");
  expect(
    approved({
      reviews: [approval, { ...approval, id: 2, submittedAt: "2", state: "CHANGES_REQUESTED" }],
    }),
  ).toBe(false);
  expect(
    approved({ reviews: [{ ...approval, id: 2, submittedAt: "2", state: "DISMISSED" }, approval] }),
  ).toBe(false);
  expect(
    approved({
      reviews: [approval, { ...approval, id: 2, user: "another", state: "CHANGES_REQUESTED" }],
    }),
  ).toBe(false);
});

test("a label approval is the pull request's, not a commit's, so it survives a push", () => {
  const labelled = { reviews: [], labels: ["jigs:approved"] };
  expect(approved(labelled, "label")).toBe(true);
  expect(approved({ ...labelled, headSha: "later" }, "label")).toBe(true);
  expect(approved({ ...labelled, labels: ["needs-review"] }, "label")).toBe(false);
  // The two signals are independent: neither stands in for the other.
  expect(approved(labelled, "review")).toBe(false);
  expect(approved({}, "label")).toBe(false);
});

test("the configured signal is the one the gate classifies with", () => {
  const labelled = { reviews: [], labels: ["jigs:approved"] };
  expect(classifyPullRequestState(read(labelled, "review"), SCOPE).wakes).toEqual([]);
  expect(classifyPullRequestState(read(labelled, "label"), SCOPE).wakes).toEqual([
    { kind: "merge-ready", headSha: "new", retryNoted: false },
  ]);
});

test("a pull request GitHub is not ready to merge becomes merge-ready when it is", () => {
  expect(classifyPullRequestState(read({ mergeState: "unstable" }), SCOPE).wakes).toEqual([]);
  expect(classifyPullRequestState(snapshot, SCOPE).wakes).toEqual([
    { kind: "merge-ready", headSha: "new", retryNoted: false },
  ]);
});

test("closed snapshots yield no agent or merge work", () => {
  expect(classifyPullRequestState(read({ state: "closed", ci: "red" }), SCOPE).wakes).toEqual([
    { kind: "closed", merged: false },
  ]);
});

test("a stood-down head does not ask to be merged again", () => {
  const stoodDown: Partial<Facts> = {
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
  expect(classifyPullRequestState(read(stoodDown), SCOPE).wakes).toEqual([]);
  // A push moves the head, and the approval of that new head is new work.
  expect(
    classifyPullRequestState(
      read({
        ...stoodDown,
        headSha: "newer",
        reviews: facts.reviews.map((review) => ({ ...review, commitSha: "newer" })),
      }),
      SCOPE,
    ).wakes,
  ).toEqual([{ kind: "merge-ready", headSha: "newer", retryNoted: false }]);
});

test("a refusal jigs can wait out is kept apart from one only a new commit fixes", () => {
  const refusal = (patch: Partial<Facts>, head = "new") => mergeRefusal(read(patch), head);
  expect(refusal({})).toBeNull();
  for (const mergeState of ["unstable", "blocked", "behind", "unknown", "has_hooks"]) {
    expect(refusal({ mergeState })).toMatchObject({ transient: true });
  }
  expect(refusal({ ci: "pending" })).toMatchObject({ transient: true });
  // No check at all may be CI that has not started yet, or a repository without it.
  expect(refusal({ ci: "none" })).toEqual({
    reason: expect.stringMatching(/no checks have reported on new.*not have started yet.*has none/),
    transient: true,
  });
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
  const noted = (reason: "merge" | "merge-retry"): PullRequestSnapshot =>
    read({
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
  expect(classifyPullRequestState(noted("merge-retry"), SCOPE).wakes).toEqual([
    { kind: "merge-ready", headSha: "new", retryNoted: true },
  ]);
  expect(classifyPullRequestState(noted("merge"), SCOPE).wakes).toEqual([]);
});
