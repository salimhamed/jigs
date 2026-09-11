import { expect, test } from "vitest";
import { answerReviewPrompt } from "./answer-review.prompt.ts";

test("the answer review prompt renders the threads", () => {
  const rendered = answerReviewPrompt({ threads: "THE-THREADS" });
  expect(rendered).toContain("came back with review comments");
  expect(rendered).toContain("THE-THREADS");
});
