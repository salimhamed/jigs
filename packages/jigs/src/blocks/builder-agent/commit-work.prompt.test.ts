import { expect, test } from "vitest";
import { commitWorkPrompt } from "./commit-work.prompt.ts";

test("the commit prompt asks for the commit and takes nothing to render", () => {
  expect(commitWorkPrompt({})).toContain("commit all of it");
});
