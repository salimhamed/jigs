import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExecuteJevStep } from "../workflow/agents/jev.ts";
import { jevAnswering, unsureJev, yesProbability } from "../workflow/agents/jev-test-fixtures.ts";
import {
  isIrrelevantWake,
  readWaiting,
  type Waiting,
  wakeEvidence,
  wakeState,
} from "./wake-relevance.ts";

const { getHookByToken, hooksList, getComment } = vi.hoisted(() => ({
  getHookByToken: vi.fn(),
  hooksList: vi.fn(),
  getComment: vi.fn(),
}));
vi.mock("workflow/api", () => ({ getHookByToken }));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ hooks: { list: hooksList } }) }));
vi.mock("../providers/linear.ts", async (importActual) => ({
  ...(await importActual<object>()),
  getComment,
}));

const labeled = {
  action: "labeled",
  label: { name: "needs-design", color: "fff" },
  sender: { login: "dana", type: "User", id: 9 },
  pull_request: { number: 41, draft: false, head: { sha: "3f9c2ab77e" } },
};
const token = "github:pr:acme/app#41";
const watching: Waiting = {
  for: "pull request activity",
  pullRequest: "acme/app#41",
  reactsTo: "reviews",
};
const deps = (executeJev: ExecuteJevStep, waiting: Waiting | null = watching) => ({
  executeJev,
  readWaiting: async () => waiting,
});

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  getHookByToken.mockReset();
  hooksList.mockReset();
  getComment.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

test("evidence keeps only the fields that say what happened", () => {
  expect(wakeEvidence("github", "pull_request", labeled)).toEqual({
    provider: "github",
    event: "pull_request",
    action: "labeled",
    sender: { login: "dana", type: "User" },
    label: { name: "needs-design" },
  });
  expect(
    wakeEvidence("linear", "Comment", {
      action: "create",
      data: { body: "x".repeat(2500), issueId: "i" },
    }),
  ).toMatchObject({ data: { body: `${"x".repeat(2000)}…` } });
});

test("evidence flags a comment that carries jigs' own marker, but not a quoted one", () => {
  const marked =
    'CI is green.\n\n<!-- jigs:v1 {"scope":"s","run":"r","kind":"status","reason":"ci"} -->';
  const comment = (body: string) =>
    wakeEvidence("github", "issue_comment", { action: "created", comment: { body } });
  expect(comment(marked)).toMatchObject({ fromJigs: true });
  expect(comment(marked.replace("<!--", "> <!--"))).not.toHaveProperty("fromJigs");
});

test("Jev is asked about the event beside what the run is waiting for", async () => {
  const executeJev = jevAnswering(() => yesProbability(0.5));
  await isIrrelevantWake("github", "pull_request", labeled, token, deps(executeJev));
  const [[wire]] = executeJev.mock.calls as unknown as [[{ state: unknown }]];
  expect(wire.state).toEqual(
    wakeState(wakeEvidence("github", "pull_request", labeled) ?? {}, watching),
  );
});

test("head, lifecycle and CI events always wake, without asking", async () => {
  const executeJev = jevAnswering(() => yesProbability(0.01));
  for (const [event, action] of [
    ["pull_request", "closed"],
    ["pull_request", "synchronize"],
    ["check_suite", "completed"],
  ] as const) {
    expect(await isIrrelevantWake("github", event, { action }, token, deps(executeJev))).toBe(
      false,
    );
  }
  expect(
    await isIrrelevantWake("linear", "Issue", { action: "remove" }, "t", deps(executeJev)),
  ).toBe(false);
  expect(executeJev).not.toHaveBeenCalled();
});

test("only a confident no skips the wake", async () => {
  const ask = (probability: number) =>
    isIrrelevantWake(
      "github",
      "pull_request",
      labeled,
      token,
      deps(jevAnswering(() => yesProbability(probability))),
    );
  expect(await ask(0.04)).toBe(true);
  expect(await ask(0.96)).toBe(false);
  expect(await isIrrelevantWake("github", "pull_request", labeled, token, deps(unsureJev()))).toBe(
    false,
  );
});

test("a token no run holds wakes without asking, so the resume reports it", async () => {
  const executeJev = jevAnswering(() => yesProbability(0.01));
  expect(
    await isIrrelevantWake("github", "pull_request", labeled, token, deps(executeJev, null)),
  ).toBe(false);
  expect(executeJev).not.toHaveBeenCalled();
});

test("without a key, or when Jev or the waiting read fails, every delivery wakes", async () => {
  const failing = jevAnswering(() => {
    throw new Error("OpenRouter is down");
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  expect(await isIrrelevantWake("github", "pull_request", labeled, token, deps(failing))).toBe(
    false,
  );
  const executeJev = jevAnswering(() => yesProbability(0.01));
  expect(
    await isIrrelevantWake("github", "pull_request", labeled, token, {
      executeJev,
      readWaiting: async () => {
        throw new Error("World unavailable");
      },
    }),
  ).toBe(false);
  vi.stubEnv("OPENROUTER_API_KEY", undefined);
  expect(await isIrrelevantWake("github", "pull_request", labeled, token, deps(executeJev))).toBe(
    false,
  );
  expect(executeJev).not.toHaveBeenCalled();
});

test("a pull request wait carries the head and draft flag the delivery reports", async () => {
  getHookByToken.mockResolvedValue({ runId: "run-1" });
  expect(await readWaiting(token, labeled)).toEqual({
    for: "pull request activity",
    pullRequest: "acme/app#41",
    reactsTo: expect.any(String),
    head: "3f9c2ab",
    draft: false,
  });
  expect(hooksList).not.toHaveBeenCalled();
});

test("a ticket wait is the open question, or nothing when the run asked none", async () => {
  getHookByToken.mockResolvedValue({ runId: "run-1" });
  hooksList.mockResolvedValue({
    data: [{ token: "linear:issue:i-1" }, { token: "jigs:needs-human:i-1:c-9" }],
  });
  getComment.mockResolvedValue({ url: "u", body: "Fixed delay or exponential backoff?" });
  expect(await readWaiting("linear:issue:i-1", {})).toEqual({
    for: "a human reply",
    question: "Fixed delay or exponential backoff?",
  });
  expect(getComment).toHaveBeenCalledWith("c-9");

  hooksList.mockResolvedValue({ data: [{ token: "linear:issue:i-1" }] });
  expect(await readWaiting("linear:issue:i-1", {})).toMatchObject({
    for: "nothing on this ticket",
  });

  hooksList.mockRejectedValue(new Error("World unavailable"));
  expect(await readWaiting("linear:issue:i-1", {})).toEqual({ for: "unknown" });

  getHookByToken.mockRejectedValue(new Error("not found"));
  expect(await readWaiting("linear:issue:i-1", {})).toBeNull();
});
