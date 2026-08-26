import { expect, test } from "vitest";
import { prToken, ticketToken } from "./tokens";

test("pr token, including dots and dashes in names", () => {
  expect(prToken({ owner: "acme-inc", repo: "api.v2", number: 41 })).toBe(
    "github:pr:acme-inc/api.v2#41",
  );
});

test("ticket token carries the UUID", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  expect(ticketToken(issueId)).toBe(`linear:ticket:${issueId}`);
});
