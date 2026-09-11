// Test-only helpers. Not reachable from either barrel and not an entry of the
// build, so nothing here ships: a block test asserts the prompt name and data
// its call site passed, and the words themselves are the template's business.

import type { Prompt, PromptRef } from "./plan.ts";

export function promptRef(call: { prompt: Prompt } | undefined): PromptRef {
  const prompt = call?.prompt;
  if (prompt === undefined || typeof prompt === "string") {
    throw new Error(
      `expected a prompt reference, got ${JSON.stringify(prompt)}`,
    );
  }
  return prompt;
}
