import { expect, test } from "vitest";
import { codeReviewPrompt } from "./code-review.ts";

test("the code review prompt has no slot for the brief", () => {
  expect(codeReviewPrompt).toContain("{{TICKET}}");
  expect(codeReviewPrompt).toContain("{{BASE_SHA}}");
  expect(codeReviewPrompt).not.toContain("{{BRIEF}}");
});
