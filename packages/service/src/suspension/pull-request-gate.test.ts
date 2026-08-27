import { expect, test } from "vitest";
import type { PrSnapshot, ReviewThread } from "../providers/github";
import {
  classifyPrState,
  emptyGateCursor,
  type GateCursor,
} from "./pull-request-gate";

const empty: GateCursor = emptyGateCursor();

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  merged: false,
  headSha: "head-1",
  viewer: "jigs-bot",
  reviews: [],
  reviewThreads: [],
  ci: "pending",
  failingChecks: [],
  ...overrides,
});

const review = (id: number, state: string, user = "reviewer") => ({
  id,
  state,
  body: state === "CHANGES_REQUESTED" ? "please fix" : "",
  user,
  submittedAt: "2026-08-26T12:00:00Z",
});

const thread = (
  rootId: number,
  authors: Array<[number, string]>,
): ReviewThread => ({
  rootId,
  path: "src/gate.ts",
  line: 12,
  comments: authors.map(([id, user]) => ({
    id,
    rootId,
    body: `comment ${id}`,
    user,
    path: "src/gate.ts",
    line: 12,
    createdAt: "2026-08-26T12:00:00Z",
  })),
});

const check = (name: string) => ({
  name,
  conclusion: "failure",
  url: "http://ci.test/1",
});

test("no change yields no wakes — the unsatisfied-wake core", () => {
  const result = classifyPrState(snapshot(), empty);
  expect(result.wakes).toEqual([]);
  expect(result.done).toBe(false);
});

test("an approval yields approved but no longer ends the gate", () => {
  const result = classifyPrState(
    snapshot({ reviews: [review(1, "APPROVED")] }),
    empty,
  );
  expect(result.wakes).toEqual([
    {
      kind: "approved",
      reviewId: 1,
      reviewer: "reviewer",
      submittedAt: "2026-08-26T12:00:00Z",
    },
  ]);
  // Human-merges mode has to keep listening until the PR actually closes.
  expect(result.done).toBe(false);
});

test("changes requested since the cursor yields a wake but keeps the gate open", () => {
  const result = classifyPrState(
    snapshot({ reviews: [review(2, "CHANGES_REQUESTED")] }),
    empty,
  );
  expect(result.wakes).toEqual([
    {
      kind: "changes-requested",
      reviewId: 2,
      reviewer: "reviewer",
      body: "please fix",
      submittedAt: "2026-08-26T12:00:00Z",
    },
  ]);
  expect(result.done).toBe(false);
});

test("already-seen reviews are not re-yielded", () => {
  const reviews = [review(2, "CHANGES_REQUESTED")];
  const first = classifyPrState(snapshot({ reviews }), empty);
  const second = classifyPrState(snapshot({ reviews }), first.cursor);
  expect(second.wakes).toEqual([]);
  expect(second.cursor.seenReviewIds).toEqual([2]);
});

test("comment-only reviews advance the cursor without a wake", () => {
  const result = classifyPrState(
    snapshot({ reviews: [review(3, "COMMENTED")] }),
    empty,
  );
  expect(result.wakes).toEqual([]);
  expect(result.cursor.seenReviewIds).toEqual([3]);
});

test("an unanswered thread since the cursor yields review-comments", () => {
  const threads = [
    thread(900, [[900, "reviewer"]]),
    thread(910, [[910, "reviewer"]]),
  ];
  const result = classifyPrState(snapshot({ reviewThreads: threads }), empty);

  expect(result.wakes).toEqual([{ kind: "review-comments", threads }]);
  expect(result.cursor.seenCommentIds).toEqual([900, 910]);
});

test("a thread whose last comment is ours yields nothing but is still recorded", () => {
  const threads = [
    thread(900, [
      [900, "reviewer"],
      [901, "jigs-bot"],
    ]),
  ];
  const result = classifyPrState(snapshot({ reviewThreads: threads }), empty);

  expect(result.wakes).toEqual([]);
  expect(result.cursor.seenCommentIds).toEqual([900, 901]);
});

test("a human's follow-up on an answered thread re-opens it", () => {
  const answered = [
    thread(900, [
      [900, "reviewer"],
      [901, "jigs-bot"],
    ]),
  ];
  const first = classifyPrState(snapshot({ reviewThreads: answered }), empty);

  const followUp = [
    thread(900, [
      [900, "reviewer"],
      [901, "jigs-bot"],
      [902, "reviewer"],
    ]),
  ];
  const second = classifyPrState(
    snapshot({ reviewThreads: followUp }),
    first.cursor,
  );
  expect(second.wakes).toEqual([
    { kind: "review-comments", threads: followUp },
  ]);
});

test("already-seen comments are not re-yielded", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const first = classifyPrState(snapshot({ reviewThreads: threads }), empty);
  const second = classifyPrState(
    snapshot({ reviewThreads: threads }),
    first.cursor,
  );
  expect(second.wakes).toEqual([]);
  expect(second.cursor.seenCommentIds).toEqual([900]);
});

test("a new red head yields ci-red naming the failing checks and the reviewer to escalate to", () => {
  const result = classifyPrState(
    snapshot({
      ci: "red",
      failingChecks: [check("test")],
      reviews: [review(1, "COMMENTED"), review(2, "COMMENTED", "salim")],
    }),
    empty,
  );
  expect(result.wakes).toEqual([
    {
      kind: "ci-red",
      headSha: "head-1",
      failing: [check("test")],
      mentionLogin: "salim",
    },
  ]);
  expect(result.cursor.ci).toEqual({ headSha: "head-1", state: "red" });
});

test("the same red head does not re-yield, but a new head does", () => {
  const red = snapshot({ ci: "red", failingChecks: [check("test")] });
  const first = classifyPrState(red, empty);
  const second = classifyPrState(red, first.cursor);
  expect(second.wakes).toEqual([]);

  const pushed = classifyPrState(
    snapshot({ ci: "red", headSha: "head-2", failingChecks: [check("test")] }),
    second.cursor,
  );
  expect(pushed.wakes).toEqual([
    expect.objectContaining({ kind: "ci-red", headSha: "head-2" }),
  ]);
});

test("a recovery to green yields ci-green, and green from nowhere yields nothing", () => {
  const fresh = classifyPrState(snapshot({ ci: "green" }), empty);
  expect(fresh.wakes).toEqual([]);

  const red = classifyPrState(
    snapshot({ ci: "red", failingChecks: [check("test")] }),
    empty,
  );
  const recovered = classifyPrState(
    snapshot({ ci: "green", headSha: "head-2" }),
    red.cursor,
  );
  expect(recovered.wakes).toEqual([{ kind: "ci-green", headSha: "head-2" }]);
  expect(recovered.cursor.ci).toEqual({ headSha: "head-2", state: "green" });
});

test("pending yields nothing and leaves the cursor's CI state alone", () => {
  const red = classifyPrState(
    snapshot({ ci: "red", failingChecks: [check("test")] }),
    empty,
  );
  const pending = classifyPrState(snapshot({ ci: "pending" }), red.cursor);
  expect(pending.wakes).toEqual([]);
  expect(pending.cursor.ci).toEqual(red.cursor.ci);
});

test("a closed PR yields closed with the merged flag and finishes the gate", () => {
  for (const merged of [true, false]) {
    const result = classifyPrState(
      snapshot({ state: "closed", merged }),
      empty,
    );
    expect(result.wakes).toEqual([{ kind: "closed", merged }]);
    expect(result.done).toBe(true);
  }
});
