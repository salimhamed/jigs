import { expect, test } from "vitest";
import { z } from "zod";
import { askModel } from "../../../blocks/agents/ask-model.ts";
import { models } from "../../../blocks/agents/harness-config.ts";
import { executeModel } from "../execute-model-request.ts";

const hasOpenRouterCredential = Boolean(process.env.OPENROUTER_API_KEY);
const answer = z.object({ word: z.string(), count: z.number() });

test.skipIf(!hasOpenRouterCredential)(
  "OpenRouter model call returns parsed structured output and a non-zero cost",
  async () => {
    const result = await askModel(
      {
        model: models.openrouter("google/gemini-2.5-flash-lite"),
        prompt: "Return the word 'sky' and the number 3.",
        output: answer,
      },
      (wire) => executeModel(wire, { workflowRunId: "live-openrouter" }),
    );

    expect(result.output).toEqual({ word: "sky", count: 3 });
  },
);
