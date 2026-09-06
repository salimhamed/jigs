import { expect, test } from "vitest";
import { readSuspensionMetadata, suspensionMetadata } from "./record";

test("envelope round-trips a suspension record", () => {
  const record = {
    key: "pr-gate:acme/api#41",
    reason: "awaiting pull request review",
    payload: { owner: "acme", repo: "api", number: 41 },
    satisfiedBy: "github:pr:acme/api#41",
  };
  expect(readSuspensionMetadata(suspensionMetadata(record))).toEqual(record);
});

test("foreign metadata reads as null", () => {
  expect(readSuspensionMetadata(undefined)).toBeNull();
  expect(readSuspensionMetadata(null)).toBeNull();
  expect(readSuspensionMetadata("suspension")).toBeNull();
  expect(readSuspensionMetadata({ some: "other metadata" })).toBeNull();
  expect(
    readSuspensionMetadata({ jigs: "suspension", record: { key: "x" } }),
  ).toBeNull();
});
