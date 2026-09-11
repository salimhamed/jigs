import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const prompt = readFileSync(
  new URL("./code-review.prompt.md", import.meta.url),
  "utf8",
);

test("the code review prompt has no slot for the brief", () => {
  expect(prompt).toContain("it.TICKET");
  expect(prompt).toContain("it.BASE_SHA");
  expect(prompt).not.toContain("it.BRIEF");
});
