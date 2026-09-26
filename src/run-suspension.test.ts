import { expect, test } from "vitest";
import { describeSuspension } from "./run-suspension.ts";
import { ticketToken } from "./workflow/linear/claim.ts";
import { needsHumanToken } from "./workflow/linear/halt-for-human.ts";
import { pullRequestToken } from "./workflow/pull-requests/pull-request.ts";

// Read through the minters, never through a token spelled out here: a reason
// derived from a prefix the minters no longer produce degrades to the generic
// one, and a test carrying its own copy of the prefix would stay green.
test("a ticket claim is not a park, and every other hook explains itself", () => {
  expect(describeSuspension(ticketToken(crypto.randomUUID()))).toBeNull();
  expect(describeSuspension(pullRequestToken({ owner: "acme", repo: "api", number: 41 }))).toEqual({
    token: "github:pr:acme/api#41",
    kind: "pull-request",
    reason: "waiting for pull request activity on acme/api#41",
    url: "https://github.com/acme/api/pull/41",
  });
  // The ticket the run was launched with, never the issue UUID in the token:
  // the identifier is what an operator can act on.
  expect(describeSuspension(needsHumanToken("issue-1", "comment-1"), "AGE-317")).toEqual({
    token: "jigs:needs-human:issue-1:comment-1",
    kind: "needs-human",
    reason: "waiting for a human reply on AGE-317",
  });
  // A workflow of its own that parks on createHook({ token }) is parked too,
  // so parkedness can never depend on jigs recognizing the token.
  expect(describeSuspension("demo:thing")).toEqual({
    token: "demo:thing",
    kind: "external",
    reason: "waiting for an external event (demo:thing)",
  });
});

// A token jigs minted but cannot take apart is still jigs' own park: the kind
// says what to do about it, and only the details are missing.
test("a park jigs minted keeps its kind when the rest of the token is unreadable", () => {
  expect(describeSuspension("github:pr:garbage")).toEqual({
    token: "github:pr:garbage",
    kind: "pull-request",
    reason: "waiting for pull request activity on garbage",
  });
  expect(describeSuspension("jigs:needs-human:onlyone")).toEqual({
    token: "jigs:needs-human:onlyone",
    kind: "needs-human",
    reason:
      "waiting for a human reply, on a ticket this halt marker does not name (jigs:needs-human:onlyone)",
  });
  // The run was launched with a ticket, so the marker does not have to name one.
  expect(describeSuspension("jigs:needs-human:onlyone", "AGE-317")).toMatchObject({
    kind: "needs-human",
    reason: "waiting for a human reply on AGE-317",
  });
});
