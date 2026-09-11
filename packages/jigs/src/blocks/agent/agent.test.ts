import { expect, test } from "vitest";
import { unwrapAgentStep } from "./agent.ts";

test("the resumeFailed marker becomes a throw carrying the provider's own words", () => {
  const detail = "no rollout found for thread id 0199-gone";
  expect(() => unwrapAgentStep({ resumeFailed: detail })).toThrow(detail);
});

test("a step result carrying neither marker passes through untouched", () => {
  const result = { text: "done", output: undefined };
  expect(unwrapAgentStep(result)).toBe(result);
});
