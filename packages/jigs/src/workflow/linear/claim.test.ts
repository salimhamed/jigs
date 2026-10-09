import { expect, test } from "vitest";
import { ticketToken } from "./ticket-token.ts";

test("ticket token carries the installation name and the UUID", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  expect(ticketToken("linear-acme", issueId)).toBe(`linear:ticket:linear-acme:${issueId}`);
});
