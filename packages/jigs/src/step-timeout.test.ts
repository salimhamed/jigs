import { expect, test } from "vitest";
import {
  DEFAULT_STEP_TIMEOUT_MINUTES,
  STEP_TIMEOUT_ENV,
  stepTimeoutMinutes,
  stepTimeoutMs,
} from "./step-timeout.ts";

test("agent steps default to 45 minutes", () => {
  expect(DEFAULT_STEP_TIMEOUT_MINUTES).toBe(45);
  expect(stepTimeoutMinutes({})).toBe(45);
  expect(stepTimeoutMs({})).toBe(45 * 60_000);
});

test("the environment overrides the default", () => {
  expect(stepTimeoutMs({ [STEP_TIMEOUT_ENV]: "90" })).toBe(90 * 60_000);
});

test("an unusable value falls back rather than stopping the service booting", () => {
  for (const raw of ["", "soon", "0", "-5", "NaN"]) {
    expect(stepTimeoutMinutes({ [STEP_TIMEOUT_ENV]: raw })).toBe(45);
  }
});
