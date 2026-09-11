import { expect, test } from "vitest";
import { ticketReviewPrompt } from "./ticket-review.prompt.ts";

test("the ticket review prompt renders the ticket", () => {
  const rendered = ticketReviewPrompt({ ticket: "AGE-313: snapshot a ticket" });
  expect(rendered).toContain("restate, not re-decide");
  expect(rendered).toContain("AGE-313: snapshot a ticket");
});
