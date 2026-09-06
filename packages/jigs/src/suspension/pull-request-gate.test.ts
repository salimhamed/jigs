import { expect, test } from "vitest";
import type { PrSnapshot, ReviewThread } from "../providers/github.ts";
import {
  ackGateCursor,
  classifyPrState,
  emptyGateCursor,
  type GateCursor,
} from "./pull-request-gate.ts";

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

test("a changes-requested review submitted with inline comments yields one wake carrying both", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const result = classifyPrState(
    snapshot({
      reviews: [review(2, "CHANGES_REQUESTED")],
      reviewThreads: threads,
    }),
    empty,
  );

  expect(result.wakes).toEqual([
    { kind: "review-comments", threads, body: "please fix" },
  ]);
});

test("an approval alongside inline comments is left alone", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const result = classifyPrState(
    snapshot({ reviews: [review(1, "APPROVED")], reviewThreads: threads }),
    empty,
  );

  expect(result.wakes.map((wake) => wake.kind)).toEqual([
    "approved",
    "review-comments",
  ]);
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

// The whole point of the self guard being id-based: on a factory running the
// operator's own token the viewer IS the reviewer, and filtering by author
// swallowed every human review comment (AGE-363).
test("a comment by the viewer's own login still yields review-comments", () => {
  const threads = [thread(900, [[900, "salim"]])];
  const result = classifyPrState(
    snapshot({ viewer: "salim", reviewThreads: threads }),
    empty,
  );

  expect(result.wakes).toEqual([{ kind: "review-comments", threads }]);
});

test("a thread whose only new comment is our own acked reply yields nothing", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const first = classifyPrState(snapshot({ reviewThreads: threads }), empty);
  expect(first.wakes).toHaveLength(1);

  const answered = [
    thread(900, [
      [900, "reviewer"],
      [901, "salim"],
    ]),
  ];
  const second = classifyPrState(
    snapshot({ viewer: "salim", reviewThreads: answered }),
    ackGateCursor(first.cursor, { selfCommentIds: [901] }),
  );

  expect(second.wakes).toEqual([]);
  expect(second.skippedSelfThreads).toBe(1);
  expect(second.cursor.seenCommentIds).toEqual([900, 901]);
  expect(second.cursor.selfCommentIds).toEqual([901]);
});

test("a human's follow-up on a thread we answered re-opens it", () => {
  const threads = [thread(900, [[900, "reviewer"]])];
  const first = classifyPrState(snapshot({ reviewThreads: threads }), empty);
  const answered = [
    thread(900, [
      [900, "reviewer"],
      [901, "salim"],
    ]),
  ];
  const second = classifyPrState(
    snapshot({ viewer: "salim", reviewThreads: answered }),
    ackGateCursor(first.cursor, { selfCommentIds: [901] }),
  );

  // The operator, on their own token: same login as our reply above.
  const followUp = [
    thread(900, [
      [900, "reviewer"],
      [901, "salim"],
      [902, "salim"],
    ]),
  ];
  const third = classifyPrState(
    snapshot({ viewer: "salim", reviewThreads: followUp }),
    second.cursor,
  );
  expect(third.wakes).toEqual([{ kind: "review-comments", threads: followUp }]);
  expect(third.skippedSelfThreads).toBe(0);
});

test("an unacked reply of ours is a wake — the guard is ids, not identity", () => {
  const threads = [
    thread(900, [
      [900, "reviewer"],
      [901, "jigs-bot"],
    ]),
  ];
  const result = classifyPrState(snapshot({ reviewThreads: threads }), empty);

  expect(result.wakes).toEqual([{ kind: "review-comments", threads }]);
  expect(result.cursor.seenCommentIds).toEqual([900, 901]);
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
  expect(result.cursor.lastRedSha).toBe("head-1");
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
  expect(recovered.cursor.lastRedSha).toBeNull();
});

test("pending yields nothing and leaves the cursor's CI state alone", () => {
  const red = classifyPrState(
    snapshot({ ci: "red", failingChecks: [check("test")] }),
    empty,
  );
  const pending = classifyPrState(snapshot({ ci: "pending" }), red.cursor);
  expect(pending.wakes).toEqual([]);
  expect(pending.cursor.lastRedSha).toBe(red.cursor.lastRedSha);
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
