import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  answerReviewPrompt,
  codeReviewPrompt,
  fixCiPrompt,
  implementPrompt,
  rebuildContextPrompt,
  ticketReviewPrompt,
} from "./defaults.ts";

const generated: Record<string, string> = {
  "answer-review.md": answerReviewPrompt,
  "code-review.md": codeReviewPrompt,
  "fix-ci.md": fixCiPrompt,
  "implement.md": implementPrompt,
  "rebuild-context.md": rebuildContextPrompt,
  "ticket-review.md": ticketReviewPrompt,
};

// The drift guard: editing the markdown without re-running
// `pnpm --filter jigs gen:prompts` fails here rather than shipping a stale
// prompt to the bundle.
test("every generated prompt matches its markdown source", () => {
  for (const [file, prompt] of Object.entries(generated)) {
    expect(prompt, file).toBe(
      readFileSync(new URL(`./${file}`, import.meta.url), "utf8"),
    );
  }
});

test("the code review prompt has no slot for the brief", () => {
  expect(codeReviewPrompt).toContain("{{TICKET}}");
  expect(codeReviewPrompt).toContain("{{BASE_SHA}}");
  expect(codeReviewPrompt).not.toContain("{{BRIEF}}");
});
