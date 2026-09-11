import { expect, test } from "vitest";
import { implementPrompt } from "./implement.prompt.ts";

test("the implement prompt renders the ticket, the brief and the findings", () => {
  const rendered = implementPrompt({
    ticket: "AGE-316: the review loop",
    brief: "THE-BRIEF",
    review: "- src/loop.ts: the CI bound is off by one",
  });
  expect(rendered).toContain("AGE-316: the review loop");
  expect(rendered).toContain("THE-BRIEF");
  expect(rendered).toContain("- src/loop.ts: the CI bound is off by one");
});
