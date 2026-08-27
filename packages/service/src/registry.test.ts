import { expect, test } from "vitest";
import { registry } from "./registry";

test("every registry entry carries a zod inputs schema and a pipeline", () => {
  expect(Object.keys(registry)).toContain("demo-crash");
  for (const entry of Object.values(registry)) {
    expect(entry.inputs.safeParse).toBeTypeOf("function");
    expect(entry.pipeline).toBeTypeOf("function");
  }
});

test("demo-crash inputs default and reject out-of-contract values", () => {
  const entry = registry["demo-crash"];
  expect(entry?.inputs.parse({})).toEqual({ stepSeconds: 3 });
  expect(entry?.inputs.safeParse({ stepSeconds: 0 }).success).toBe(false);
  expect(entry?.inputs.safeParse({ stepSeconds: "90" }).success).toBe(false);
});

test("demo-crash hook token embeds the trigger id", () => {
  expect(registry["demo-crash"]?.hookToken?.("abc")).toBe("demo:abc");
});

test("steps-demo defaults to replay mode and rejects unknown modes", () => {
  const entry = registry["steps-demo"];
  expect(entry?.inputs.parse({})).toEqual({ mode: "replay" });
  expect(entry?.inputs.parse({ mode: "bad-config" })).toEqual({
    mode: "bad-config",
  });
  expect(entry?.inputs.safeParse({ mode: "explode" }).success).toBe(false);
});

test("steps-demo hook token embeds the trigger id", () => {
  expect(registry["steps-demo"]?.hookToken?.("abc")).toBe("steps:abc");
});

test("preflight-demo declares the bindings and harnesses its runs require", () => {
  expect(registry["preflight-demo"]?.requires).toEqual({
    bindings: ["api"],
    harnesses: ["claude"],
  });
});

test("a pipeline with no requires preflights against the core set alone", () => {
  expect(registry["steps-demo"]?.requires).toBeUndefined();
});
