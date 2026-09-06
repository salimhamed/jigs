import { expect, test } from "vitest";
import {
  prToken,
  ticketToken,
  tokenFromGithubPayload,
  tokenFromLinearPayload,
} from "./tokens.ts";

test("pr token, including dots and dashes in names", () => {
  expect(prToken({ owner: "acme-inc", repo: "api.v2", number: 41 })).toBe(
    "github:pr:acme-inc/api.v2#41",
  );
});

test("ticket token carries the UUID", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  expect(ticketToken(issueId)).toBe(`linear:ticket:${issueId}`);
});

test("a pull_request_review payload reconstructs the exact pr token", () => {
  const payload = {
    action: "submitted",
    review: { id: 7, state: "approved" },
    pull_request: { number: 41, title: "Add ingress" },
    repository: {
      name: "api.v2",
      full_name: "acme-inc/api.v2",
      owner: { login: "acme-inc" },
    },
  };
  expect(tokenFromGithubPayload(payload)).toBe(
    prToken({ owner: "acme-inc", repo: "api.v2", number: 41 }),
  );
});

test("an issue_comment on a pull request routes to the pr token", () => {
  const repository = { name: "api", owner: { login: "acme" } };
  expect(
    tokenFromGithubPayload({
      action: "created",
      issue: { number: 41, pull_request: { url: "https://api/pulls/41" } },
      comment: { id: 5, body: "one more thing" },
      repository,
    }),
  ).toBe(prToken({ owner: "acme", repo: "api", number: 41 }));

  // The same event shape on a plain issue names no pull request.
  expect(
    tokenFromGithubPayload({
      action: "created",
      issue: { number: 41 },
      comment: { id: 5, body: "one more thing" },
      repository,
    }),
  ).toBe(null);
});

test("check_suite and check_run route through their pull_requests list", () => {
  const repository = { name: "api", owner: { login: "acme" } };
  const expected = prToken({ owner: "acme", repo: "api", number: 41 });
  expect(
    tokenFromGithubPayload({
      action: "completed",
      check_suite: {
        id: 9,
        conclusion: "failure",
        pull_requests: [{ number: 41 }],
      },
      repository,
    }),
  ).toBe(expected);
  expect(
    tokenFromGithubPayload({
      action: "completed",
      check_run: {
        id: 9,
        conclusion: "failure",
        pull_requests: [{ number: 41 }],
      },
      repository,
    }),
  ).toBe(expected);
});

test("a check_suite belonging to no pull request is unroutable", () => {
  expect(
    tokenFromGithubPayload({
      action: "completed",
      check_suite: { id: 9, conclusion: "success", pull_requests: [] },
      repository: { name: "api", owner: { login: "acme" } },
    }),
  ).toBe(null);
});

test("a github ping payload is unroutable", () => {
  expect(
    tokenFromGithubPayload({
      zen: "Keep it logically awesome.",
      hook_id: 1,
      repository: { name: "api", owner: { login: "acme" } },
    }),
  ).toBe(null);
  expect(tokenFromGithubPayload(null)).toBe(null);
  expect(tokenFromGithubPayload("pull_request")).toBe(null);
  expect(
    tokenFromGithubPayload({ pull_request: { number: "41" }, repository: {} }),
  ).toBe(null);
});

test("a linear Comment payload reconstructs the exact ticket token", () => {
  const issueId = "68bc9696-35d5-442d-ab56-214c8cfefbec";
  const payload = {
    action: "create",
    type: "Comment",
    data: { id: "comment-1", body: "looks good", issueId },
    webhookTimestamp: 1_756_200_000_000,
  };
  expect(tokenFromLinearPayload(payload)).toBe(ticketToken(issueId));
});

test("a non-Comment linear payload is unroutable", () => {
  expect(
    tokenFromLinearPayload({
      action: "update",
      type: "Issue",
      data: { id: "issue-1" },
    }),
  ).toBe(null);
  expect(tokenFromLinearPayload({ type: "Comment", data: {} })).toBe(null);
  expect(tokenFromLinearPayload(null)).toBe(null);
});
