import { expect, test } from "vitest";
import { greet } from "./index.ts";

test("greet returns Hello World", () => {
  expect(greet()).toBe("Hello World");
});
