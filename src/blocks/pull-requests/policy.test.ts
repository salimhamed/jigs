import { expect, test } from "vitest";
import { approvalSchema, mergeSchema } from "./policy.ts";

test("merge policy preserves the factory configuration defaults", () => {
  expect(mergeSchema.parse({})).toEqual({
    by: "human",
    method: "squash",
    approval: { kind: "review" },
  });
});

test("approval signals accept reviews and named labels", () => {
  expect(approvalSchema.parse({ kind: "review" })).toEqual({ kind: "review" });
  expect(approvalSchema.parse({ kind: "label", name: "jigs:approved" })).toEqual({
    kind: "label",
    name: "jigs:approved",
  });
  expect(() => approvalSchema.parse({ kind: "label", name: "" })).toThrow();
});
