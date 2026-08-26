import { expect, test } from "vitest";
import type { PrSnapshot } from "../providers/github";
import { classifyPrState, type GateCursor } from "./pull-request-gate";

const empty: GateCursor = { seenReviewIds: [] };

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  merged: false,
  reviews: [],
  ...overrides,
});

const review = (id: number, state: string) => ({
  id,
  state,
  body: state === "CHANGES_REQUESTED" ? "please fix" : "",
  user: "reviewer",
  submittedAt: "2026-08-26T12:00:00Z",
});

test("no change yields no wakes — the unsatisfied-wake core", () => {
  const result = classifyPrState(snapshot(), empty);
  expect(result.wakes).toEqual([]);
  expect(result.done).toBe(false);
});

test("a new approval yields approved and finishes the gate", () => {
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
  expect(result.done).toBe(true);
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
  const first = classifyPrState(
    snapshot({ reviews: [review(2, "CHANGES_REQUESTED")] }),
    empty,
  );
  const second = classifyPrState(
    snapshot({ reviews: [review(2, "CHANGES_REQUESTED")] }),
    first.cursor,
  );
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
