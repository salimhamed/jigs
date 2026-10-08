import { expect, test } from "vitest";
import { describeSuspension } from "./run-suspension.ts";
import { linearListeningToken, linearSessionToken } from "./workflow/linear/agent-session.ts";
import { ticketToken } from "./workflow/linear/ticket-token.ts";
import { pullRequestToken } from "./workflow/pull-requests/pull-request.ts";
import { slackThreadToken } from "./workflow/slack/thread-token.ts";

// Read through the minters, never through a token spelled out here: a reason
// derived from a prefix the minters no longer produce degrades to the generic
// one, and a test carrying its own copy of the prefix would stay green.
test("a ticket claim or a session's ownership hook is not a park, and every other hook explains itself", () => {
  expect(describeSuspension(ticketToken("linear-acme", crypto.randomUUID()))).toBeNull();
  expect(describeSuspension(linearSessionToken("linear-acme", crypto.randomUUID()))).toBeNull();
  expect(
    describeSuspension(
      pullRequestToken({ installationName: "github-acme", owner: "acme", repo: "api", number: 41 }),
    ),
  ).toEqual({
    token: "github:pr:github-acme:acme/api#41",
    kind: "pull-request",
    reason: "waiting for pull request activity on acme/api#41",
    url: "https://github.com/acme/api/pull/41",
  });
  expect(
    describeSuspension(slackThreadToken("slack-acme", "C0123ABCD", "1790723244.335019")),
  ).toEqual({
    token: "slack:thread:slack-acme:C0123ABCD:1790723244.335019",
    kind: "slack-thread",
    reason: "waiting for a reply in the Slack thread 1790723244.335019 in C0123ABCD",
  });
  expect(describeSuspension(linearListeningToken("linear-acme", "session-1"))).toEqual({
    token: "linear:listening:linear-acme:session-1",
    kind: "linear-listening",
    reason: "waiting for a reply in Linear agent session session-1",
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
});
