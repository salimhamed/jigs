import { expect, test } from "vitest";
import { codeReviewPrompt } from "./code-review.prompt.ts";

const rendered = codeReviewPrompt({
  ticket: "AGE-316: the review loop",
  baseSha: "base-sha-1",
});

test("the code review prompt renders the ticket and the branch point", () => {
  expect(rendered).toContain("AGE-316: the review loop");
  expect(rendered).toContain("git diff base-sha-1...HEAD");
});

test("the code review prompt has no slot for the brief", () => {
  expect(rendered).not.toContain("## The brief");
  codeReviewPrompt({
    ticket: "AGE-316: the review loop",
    baseSha: "base-sha-1",
    // @ts-expect-error the reviewer judges against the ticket, never the brief
    brief: "SECRET-BRIEF-TEXT",
  });
});
