// The approval gate is a type, not a runtime check: publication accepts only a
// change carrying the commit a review approved, so tsc is what stops a stopped
// result from being published. `pnpm typecheck` fails if that stops being true.

import { expect, test } from "vitest";
import type { ImplementAndReviewResult, PublishApprovedChangeOptions } from "./types.ts";

function publishableChange(
  result: ImplementAndReviewResult,
): PublishApprovedChangeOptions["change"] {
  if (result.status === "approved") return result.change;
  // @ts-expect-error a stopped change carries no approval and cannot be published
  return result.change;
}

test("only an approved change can be published", () => {
  expect(publishableChange).toBeTypeOf("function");
});
