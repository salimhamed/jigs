import { expect, test } from "vitest";
import { ticketReviewPrompt } from "./ticket-review.prompt.ts";

test("the ticket review prompt renders the ticket", () => {
  const rendered = ticketReviewPrompt({ ticket: "AGE-313: snapshot a ticket" });
  expect(rendered).toContain("restate, not re-decide");
  expect(rendered).toContain("AGE-313: snapshot a ticket");
});

test("the ticket review prompt asks all knowable questions in one round", () => {
  const rendered = ticketReviewPrompt({ ticket: "AGE-435: review a ticket" });

  expect(rendered).toContain("one exhaustive round");
  expect(rendered).toContain('"if 1b, then ..."');
  expect(rendered).toMatch(
    /only\s+when the human's answer reveals a question you genuinely could not have known/,
  );
  expect(rendered).toContain("Take it as settled");
  expect(rendered).toContain("never ask it again");
});
