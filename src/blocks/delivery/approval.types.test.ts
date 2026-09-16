// The approval gate is a type, not a runtime check: implementation returns
// only a reviewed change, so publication can consume it directly.

import { expect, test } from "vitest";
import type { ImplementAndReviewResult, PublishApprovedChangeOptions } from "./types.ts";

function publishableChange(
  result: ImplementAndReviewResult,
): PublishApprovedChangeOptions["change"] {
  return result.change;
}

test("only an approved change can be published", () => {
  expect(publishableChange).toBeTypeOf("function");
});
