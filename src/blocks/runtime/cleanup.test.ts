import { expect, test } from "vitest";
import {
  CLEANUP_DIRECTIVE_ATTRIBUTE,
  CLEANUP_STATE_ATTRIBUTE,
  cleanupFromAttributes,
  encodeCleanupProgress,
} from "./cleanup.ts";

test("cleanup progress stays within the SDK attribute bound", () => {
  const value = encodeCleanupProgress({
    status: "failed",
    outcome: "failure",
    action: "release",
    released: 12,
    kept: 8,
    failed: 3,
    unknown: 5,
    detail: "x".repeat(1000),
  });
  expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(256);
  expect(JSON.parse(value)).not.toHaveProperty("detail");
});

test("malformed cleanup state stays observable and conservative", () => {
  expect(
    cleanupFromAttributes({
      [CLEANUP_DIRECTIVE_ATTRIBUTE]: "delete-everything",
      [CLEANUP_STATE_ATTRIBUTE]: "not json",
    }),
  ).toEqual({
    directive: "automatic",
    status: "failed",
    detail: "cleanup progress attribute is malformed",
  });
});
