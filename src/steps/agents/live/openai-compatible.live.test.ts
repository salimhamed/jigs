import { expect, test } from "vitest";
import { z } from "zod";
import { askModel } from "../../../blocks/agents/ask-model.ts";
import { models } from "../../../blocks/agents/harness-config.ts";
import { executeModel } from "../execute-model-request.ts";

const baseUrl = process.env.JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL;
const model = process.env.JIGS_TEST_OPENAI_COMPATIBLE_MODEL;
const configured = baseUrl !== undefined && baseUrl !== "" && model !== undefined && model !== "";
const reachable = configured
  ? await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(3_000),
    })
      .then((response) => response.ok)
      .catch(() => false)
  : false;
const answer = z.object({ word: z.string(), count: z.number() });

test.skipIf(!configured || !reachable)(
  "OpenAI-compatible model call returns parsed structured output",
  async () => {
    const result = await askModel(
      {
        model: models.openaiCompatible({
          name: "live-openai-compatible",
          baseUrl: baseUrl as string,
          model: model as string,
        }),
        prompt: "Return the word 'sky' and the number 3.",
        output: answer,
      },
      (wire) => executeModel(wire, { workflowRunId: "live-openai-compatible" }),
    );

    expect(result.output).toEqual({ word: "sky", count: 3 });
  },
);
