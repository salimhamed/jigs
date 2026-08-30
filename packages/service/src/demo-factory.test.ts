import { expect, test } from "vitest";
import { demoFactory } from "./demo-factory";
import type { Factory } from "./factory";

// Read through the interface rather than the literal: these are assertions
// about what the demo factory declares, including the fields it omits.
const pipelines: Factory["pipelines"] = demoFactory.pipelines;

test("every demo entry carries a zod inputs schema and a pipeline", () => {
  expect(Object.keys(pipelines)).toContain("demo-crash");
  for (const entry of Object.values(pipelines)) {
    expect(entry.inputs.safeParse).toBeTypeOf("function");
    expect(entry.pipeline).toBeTypeOf("function");
  }
});

test("demo-crash inputs default and reject out-of-contract values", () => {
  const entry = pipelines["demo-crash"];
  expect(entry?.inputs.parse({})).toEqual({ stepSeconds: 3 });
  expect(entry?.inputs.safeParse({ stepSeconds: 0 }).success).toBe(false);
  expect(entry?.inputs.safeParse({ stepSeconds: "90" }).success).toBe(false);
});

test("demo-crash hook token embeds the trigger id", () => {
  expect(pipelines["demo-crash"]?.hookToken?.("abc")).toBe("demo:abc");
});

test("steps-demo defaults to replay mode and rejects unknown modes", () => {
  const entry = pipelines["steps-demo"];
  expect(entry?.inputs.parse({})).toEqual({ mode: "replay" });
  expect(entry?.inputs.parse({ mode: "bad-config" })).toEqual({
    mode: "bad-config",
  });
  expect(entry?.inputs.safeParse({ mode: "explode" }).success).toBe(false);
});

test("steps-demo hook token embeds the trigger id", () => {
  expect(pipelines["steps-demo"]?.hookToken?.("abc")).toBe("steps:abc");
});

test("preflight-demo declares the bindings and harnesses its runs require", () => {
  expect(pipelines["preflight-demo"]?.requires).toEqual({
    bindings: ["api"],
    harnesses: ["claude"],
  });
});

test("ticket-review-demo takes an issue uuid and resumes on the ticket claim", () => {
  const entry = pipelines["ticket-review-demo"];
  expect(
    entry?.inputs.parse({ issueId: crypto.randomUUID(), cwd: "/wt" }),
  ).toMatchObject({ cwd: "/wt" });
  expect(
    entry?.inputs.safeParse({ issueId: "AGE-313", cwd: "/wt" }).success,
  ).toBe(false);
  expect(entry?.requires).toEqual({ harnesses: ["claude"] });
  expect(entry?.hookToken).toBeUndefined();
});

test("a pipeline with no requires preflights against the core set alone", () => {
  expect(pipelines["steps-demo"]?.requires).toBeUndefined();
});
