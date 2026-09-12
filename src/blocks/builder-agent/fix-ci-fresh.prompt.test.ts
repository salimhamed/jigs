import { expect, test } from "vitest";
import { fixCiFreshPrompt } from "./fix-ci-fresh.prompt.ts";

test("the rebuilt fix CI prompt renders the record the fix is made from", () => {
  const rendered = fixCiFreshPrompt({
    ticket: "AGE-316: the review loop",
    brief: "THE-BRIEF",
    diff: "THE-DIFF",
    checks: "THE-CHECKS",
    attempt: "2 of 3",
  });
  expect(rendered).toContain("AGE-316: the review loop");
  expect(rendered).toContain("THE-BRIEF");
  expect(rendered).toContain("THE-DIFF");
  expect(rendered).toContain("THE-CHECKS");
  expect(rendered).toContain("attempt 2 of 3");
  // Both arms state the same bullets, so a change to one cannot drift.
  expect(rendered).toContain("Fix the cause, never the");
});
