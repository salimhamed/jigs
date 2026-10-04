import { expect, test } from "vitest";
import { describeHookToken, parseHookToken, wakeToken } from "./hook-tokens.ts";
import { needsHumanToken } from "./linear/halt-for-human.ts";
import { ticketToken } from "./linear/ticket-token.ts";
import { pullRequestToken } from "./pull-requests/pull-request.ts";
import { slackThreadToken } from "./slack/thread-token.ts";

// Built through the minters, so a minter that drifts from the parser fails here.
const claim = ticketToken("issue-1");
const halt = needsHumanToken("issue-1", "comment-1");
const pr = pullRequestToken({ owner: "Acme", repo: "API", number: 41 });
const thread = slackThreadToken("C0123ABCD", "1790723244.335019");

test("every kind jigs mints parses back to its parts and provider", () => {
  expect(parseHookToken(claim)).toEqual({
    kind: "ticket-claim",
    provider: "linear",
    issueId: "issue-1",
  });
  expect(parseHookToken(halt)).toEqual({
    kind: "needs-human",
    provider: "linear",
    halt: { issueId: "issue-1", commentId: "comment-1" },
  });
  expect(parseHookToken(pr)).toEqual({
    kind: "pull-request",
    provider: "github",
    slug: "acme/api#41",
    pr: { owner: "acme", repo: "api", number: 41 },
  });
  expect(parseHookToken(thread)).toEqual({
    kind: "slack-thread",
    provider: "slack",
    thread: { channel: "C0123ABCD", threadTs: "1790723244.335019" },
  });
});

test("a token jigs did not mint parses to null and describes itself as external", () => {
  expect(parseHookToken("demo:thing")).toBeNull();
  expect(describeHookToken("demo:thing")).toEqual({
    kind: "external",
    label: "demo:thing",
    reason: "waiting for an external event (demo:thing)",
  });
});

test("a minted prefix keeps its kind when the rest is unreadable", () => {
  expect(parseHookToken("github:pr:garbage")).toMatchObject({ kind: "pull-request", pr: null });
  expect(parseHookToken("jigs:needs-human:onlyone")).toMatchObject({ halt: null });
  expect(parseHookToken("slack:thread:C0123ABCD")).toMatchObject({ thread: null });
});

test("a halt is woken through its ticket claim, every other wait through its own token", () => {
  expect(wakeToken(halt)).toBe(claim);
  expect(wakeToken(claim)).toBe(claim);
  expect(wakeToken("jigs:needs-human:onlyone")).toBe("jigs:needs-human:onlyone");
});

test("every kind describes what it names and what a run holding it waits for", () => {
  expect(describeHookToken(claim)).toMatchObject({ label: "Linear issue issue-1" });
  expect(describeHookToken(claim, "AGE-317")).toMatchObject({ label: "Linear ticket AGE-317" });
  expect(describeHookToken(halt, "AGE-317")).toEqual({
    kind: "needs-human",
    label: "the question on AGE-317",
    reason: "waiting for a human reply on AGE-317",
  });
  expect(describeHookToken(pr)).toEqual({
    kind: "pull-request",
    label: "pull request acme/api#41",
    reason: "waiting for pull request activity on acme/api#41",
    url: "https://github.com/acme/api/pull/41",
  });
  expect(describeHookToken(thread)).toEqual({
    kind: "slack-thread",
    label: "the Slack thread 1790723244.335019 in C0123ABCD",
    reason: "waiting for a reply in the Slack thread 1790723244.335019 in C0123ABCD",
  });
});
