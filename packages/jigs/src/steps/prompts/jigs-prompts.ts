// jigs' own prompts, keyed by the short names its blocks pass. Each one is the
// `.prompt.md` file sitting beside the block that calls it; the package ships
// those markdown files alongside dist/, so the names below are the whole
// public handle on them. `@plain-language` is a fragment rather than a prompt:
// the `@` prefix is the convention for something a template includes.

import path from "node:path";
import { packageRoot } from "../../config/package-root.ts";
import {
  createPromptRegistry,
  type PromptRegistry,
  type PromptRegistryOptions,
  type PromptSource,
} from "./registry.ts";

const root = packageRoot();

const shipped = (relative: string): PromptSource => ({
  file: path.join(root, "src", relative),
});

export const jigsPromptSources: Record<string, PromptSource> = {
  "@plain-language": shipped("blocks/ticket/plain-language.prompt.md"),
  "answer-review": shipped("blocks/builder-agent/answer-review.prompt.md"),
  "code-review": shipped("blocks/builder-agent/code-review.prompt.md"),
  "commit-work": shipped("blocks/builder-agent/commit-work.prompt.md"),
  "fix-ci": shipped("blocks/builder-agent/fix-ci.prompt.md"),
  "fix-ci-fresh": shipped("blocks/builder-agent/fix-ci-fresh.prompt.md"),
  implement: shipped("blocks/builder-agent/implement.prompt.md"),
  "read-reply": shipped("blocks/builder-agent/read-reply.prompt.md"),
  "rebuild-context": shipped("blocks/agent/rebuild-context.prompt.md"),
  "ticket-review": shipped("blocks/ticket/ticket-review.prompt.md"),
};

/** Every prompt jigs ships, and nothing else. */
export const jigsPrompts: PromptRegistry =
  createPromptRegistry(jigsPromptSources);

/**
 * jigs' prompts with a factory's own layered over them: a name the factory
 * registers that jigs also ships replaces it, and a name jigs does not ship is
 * simply added. This is what a factory hands `runAgent`.
 */
export function withPrompts(
  overrides: Record<string, PromptSource>,
  options?: PromptRegistryOptions,
): PromptRegistry {
  return createPromptRegistry(
    { ...jigsPromptSources, ...overrides },
    options ?? {},
  );
}
