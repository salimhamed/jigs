import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ticketReviewPrompt } from "./defaults.ts";

// The drift guard: editing the markdown without re-running
// `pnpm --filter jigs gen:prompts` fails here rather than shipping a stale
// prompt to the bundle.
test("the generated prompt module matches the markdown source", () => {
  const source = readFileSync(
    new URL("./ticket-review.md", import.meta.url),
    "utf8",
  );
  expect(ticketReviewPrompt).toBe(source);
});
