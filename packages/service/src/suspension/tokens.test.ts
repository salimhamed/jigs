import { expect, test } from "vitest";
import { parsePrToken, parseTicketToken, prToken, ticketToken } from "./tokens";

test("pr token round-trips, including dots and dashes in names", () => {
  const pr = { owner: "acme-inc", repo: "api.v2", number: 41 };
  expect(prToken(pr)).toBe("github:pr:acme-inc/api.v2#41");
  expect(parsePrToken(prToken(pr))).toEqual(pr);
});

test("ticket token round-trips a UUID", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  expect(ticketToken(issueId)).toBe(`linear:ticket:${issueId}`);
  expect(parseTicketToken(ticketToken(issueId))).toEqual({ issueId });
});

test("parsers reject foreign tokens", () => {
  expect(
    parsePrToken("linear:ticket:68bc9696-35d5-442d-ab56-214c8cfefbec"),
  ).toBeNull();
  expect(parsePrToken("github:pr:acme/api")).toBeNull();
  expect(parseTicketToken("linear:ticket:AGE-312")).toBeNull();
  expect(parseTicketToken("github:pr:acme/api#1")).toBeNull();
});
