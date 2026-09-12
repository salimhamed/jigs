import { expect, test } from "vitest";
import { fixCiPrompt } from "./fix-ci.prompt.ts";

test("the fix CI prompt renders the checks and the attempt", () => {
  const rendered = fixCiPrompt({ checks: "THE-CHECKS", attempt: "2 of 3" });
  expect(rendered).toContain("THE-CHECKS");
  expect(rendered).toContain("attempt 2 of 3");
  expect(rendered).toContain("Fix the cause, never the");
});
