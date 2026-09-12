import { expect, test } from "vitest";
import type { PrSnapshot } from "../../providers/github.ts";
import { classifyPrState, type GateCursor } from "./gate.ts";
import { isPullRequestMergeReady } from "./merge-ready.ts";

const cursor: GateCursor = {
  seenReviewIds: [],
  seenCommentIds: [],
  selfCommentIds: [],
  lastRedSha: null,
};
const snapshot: PrSnapshot = {
  state: "open",
  merged: false,
  headSha: "new",
  viewer: "agent",
  reviewThreads: [],
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
  const pending = classifyPrState({ ...snapshot, ci: "pending" }, cursor);
  expect(pending.wakes.map((wake) => wake.kind)).toEqual(["approved"]);
  expect(classifyPrState(snapshot, pending.cursor).wakes).toEqual([
    { kind: "merge-ready", headSha: "new" },
  ]);
});

test("closed snapshots yield no agent or merge work", () => {
  expect(classifyPrState({ ...snapshot, state: "closed", ci: "red" }, cursor).wakes).toEqual([
    { kind: "closed", merged: false },
  ]);
});

test("unchanged ready snapshots do not retry refused merges on comment webhooks", () => {
  const first = classifyPrState(snapshot, cursor);
  expect(first.wakes.some((wake) => wake.kind === "merge-ready")).toBe(true);
  const ownCommentWebhook = classifyPrState(snapshot, first.cursor);
  expect(ownCommentWebhook.wakes).toEqual([]);
  expect(classifyPrState(snapshot, ownCommentWebhook.cursor).wakes).toEqual([]);
});

test("a new readiness transition permits another merge attempt on the same head", () => {
  const first = classifyPrState(snapshot, cursor);
  const pending = classifyPrState({ ...snapshot, ci: "pending" }, first.cursor);
  expect(pending.wakes).toEqual([]);
  expect(classifyPrState(snapshot, pending.cursor).wakes).toEqual([
    { kind: "merge-ready", headSha: "new" },
  ]);
});
