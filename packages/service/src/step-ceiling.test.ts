import { STEP_TIMEOUT_ENV } from "jigs";
import { expect, test } from "vitest";
import { describeStepCeiling, raiseStepCeiling } from "./step-ceiling.ts";

test("the dispatcher is raised to the configured ceiling, 45 minutes by default", async () => {
  const seen: number[] = [];
  const install = (timeoutMs: number) => {
    seen.push(timeoutMs);
  };

  expect(await raiseStepCeiling({}, install)).toBe(45 * 60_000);
  expect(await raiseStepCeiling({ [STEP_TIMEOUT_ENV]: "90" }, install)).toBe(
    90 * 60_000,
  );
  expect(seen).toEqual([45 * 60_000, 90 * 60_000]);
});

test("the startup line says where the value came from", () => {
  expect(describeStepCeiling({})).toBe("45m (default)");
  expect(describeStepCeiling({ [STEP_TIMEOUT_ENV]: "90" })).toBe(
    `90m (${STEP_TIMEOUT_ENV})`,
  );
});
