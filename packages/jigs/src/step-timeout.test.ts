import { expect, test } from "vitest";
import {
  STEP_TIMEOUT_ENV,
  stepTimeoutMinutes,
  stepTimeoutMs,
} from "./step-timeout.ts";

test("a step is uncapped unless the factory asks for a cap", () => {
  expect(stepTimeoutMinutes({})).toBeNull();
  expect(stepTimeoutMs({})).toBeNull();
});

test("the environment carries the cap when there is one", () => {
  expect(stepTimeoutMinutes({ [STEP_TIMEOUT_ENV]: "90" })).toBe(90);
  expect(stepTimeoutMs({ [STEP_TIMEOUT_ENV]: "90" })).toBe(90 * 60_000);
});

test("an unusable value reads as no cap rather than stopping the service booting", () => {
  for (const raw of ["", "soon", "0", "-5", "NaN"]) {
    expect(stepTimeoutMinutes({ [STEP_TIMEOUT_ENV]: raw })).toBeNull();
  }
});
