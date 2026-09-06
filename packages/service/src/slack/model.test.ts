import { expect, test } from "vitest";
import { resolveSlackModel } from "./model";

// No network: constructing a provider model calls nothing. What is worth
// pinning is that the config's model id reaches the model and that the key
// comes from the env this service was handed, not the ambient one.
test("the block's model id is the model's id", () => {
  const model = resolveSlackModel("anthropic/claude-sonnet-4.5", {
    OPENROUTER_API_KEY: "sk-or-test",
  } as NodeJS.ProcessEnv);
  expect(model).toMatchObject({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4.5",
  });
});

test("a model is constructed even with no key, so the failure is Slack's to report", () => {
  // The startup gate has already refused an unset key; this must not throw
  // during construction and take the whole plugin's error path with it.
  expect(() => resolveSlackModel("openai/gpt-5", {})).not.toThrow();
});
