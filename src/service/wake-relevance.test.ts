import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { jevAnswering, unsureJev, yesProbability } from "../workflow/agents/jev-test-fixtures.ts";
import { isIrrelevantWake, wakeEvidence } from "./wake-relevance.ts";

const labeled = {
  action: "labeled",
  label: { name: "needs-design", color: "fff" },
  sender: { login: "dana", type: "User", id: 9 },
  pull_request: { number: 41 },
};

beforeEach(() => vi.stubEnv("OPENROUTER_API_KEY", "test-key"));
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

test("head, lifecycle and CI events always wake, without asking", async () => {
  const executeJev = jevAnswering(() => yesProbability(0.01));
  for (const [event, action] of [
    ["pull_request", "closed"],
    ["pull_request", "synchronize"],
    ["check_suite", "completed"],
  ] as const) {
    expect(await isIrrelevantWake("github", event, { action }, executeJev)).toBe(false);
  }
  expect(await isIrrelevantWake("linear", "Issue", { action: "remove" }, executeJev)).toBe(false);
  expect(executeJev).not.toHaveBeenCalled();
});

test("only a confident no skips the wake", async () => {
  const ask = (probability: number) =>
    isIrrelevantWake(
      "github",
      "pull_request",
      labeled,
      jevAnswering(() => yesProbability(probability)),
    );
  expect(await ask(0.04)).toBe(true);
  expect(await ask(0.96)).toBe(false);
  expect(await isIrrelevantWake("github", "pull_request", labeled, unsureJev())).toBe(false);
});

test("without a key, or when Jev fails, every delivery wakes", async () => {
  const failing = jevAnswering(() => {
    throw new Error("OpenRouter is down");
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  expect(await isIrrelevantWake("github", "pull_request", labeled, failing)).toBe(false);
  vi.stubEnv("OPENROUTER_API_KEY", undefined);
  const executeJev = jevAnswering(() => yesProbability(0.01));
  expect(await isIrrelevantWake("github", "pull_request", labeled, executeJev)).toBe(false);
  expect(executeJev).not.toHaveBeenCalled();
});
