import { expect, test } from "vitest";
import { rebuildContextPrompt } from "./rebuild-context.prompt.ts";

test("the rebuild prompt renders the ticket, the brief, the diff and the threads", () => {
  const rendered = rebuildContextPrompt({
    ticket: "AGE-316: the review loop",
    brief: "THE-BRIEF",
    diff: "THE-DIFF",
    threads: "THE-THREADS",
  });
  expect(rendered).toContain("AGE-316: the review loop");
  expect(rendered).toContain("THE-BRIEF");
  expect(rendered).toContain("THE-DIFF");
  expect(rendered).toContain("THE-THREADS");
  expect(rendered).toContain("`commitExplanation`");
  expect(rendered).toContain("Otherwise, `null`");
});
