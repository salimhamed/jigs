import { expect, test } from "vitest";
import { approvalSignalSchema, mergePolicySchema } from "./policy.ts";

test("merge policy preserves the factory configuration defaults", () => {
  expect(mergePolicySchema.parse({})).toEqual({
    by: "human",
    method: "squash",
    approval: { kind: "review" },
  });
});

test("approval signals accept reviews and named labels", () => {
  expect(approvalSignalSchema.parse({ kind: "review" })).toEqual({ kind: "review" });
  expect(approvalSignalSchema.parse({ kind: "label", name: "jigs:approved" })).toEqual({
    kind: "label",
    name: "jigs:approved",
  });
  expect(() => approvalSignalSchema.parse({ kind: "label", name: "" })).toThrow();
});
