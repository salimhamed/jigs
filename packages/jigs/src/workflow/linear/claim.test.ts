import { expect, test } from "vitest";
import { tokenFromLinearPayload } from "./claim.ts";
import { ticketToken } from "./ticket-token.ts";

test("ticket token carries the installation name and the UUID", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  expect(ticketToken("linear-acme", issueId)).toBe(`linear:ticket:linear-acme:${issueId}`);
});

test("a linear Comment payload reconstructs the exact ticket token", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  const payload = {
    action: "create",
    type: "Comment",
    data: { id: "comment-1", body: "looks good", issueId },
  };
  expect(tokenFromLinearPayload("acme", payload)).toBe(ticketToken("acme", issueId));
});

test("a non-Comment linear payload is unroutable", () => {
  expect(
    tokenFromLinearPayload("acme", {
      action: "update",
      type: "Issue",
      data: { id: "issue-1" },
    }),
  ).toBe(null);
  expect(tokenFromLinearPayload("acme", { type: "Comment", data: {} })).toBe(null);
  expect(tokenFromLinearPayload("acme", null)).toBe(null);
});
