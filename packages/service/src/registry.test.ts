import { expect, test } from "vitest";
import { registry } from "./registry";

test("every registry entry carries a zod inputs schema", () => {
  for (const entry of Object.values(registry)) {
    expect(entry.inputs.safeParse).toBeTypeOf("function");
    expect(entry.pipeline).toBeTypeOf("function");
  }
});
