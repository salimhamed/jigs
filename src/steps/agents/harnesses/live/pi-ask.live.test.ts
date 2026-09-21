import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import { askAgent } from "../../../../blocks/agents/ask-agent.ts";
import { harnesses, models } from "../../../../blocks/agents/harness-config.ts";
import { executeAgent } from "../../execute-agent.ts";
import { realPiAuthPath } from "../pi-home.ts";

const baseUrl = process.env.JIGS_TEST_OPENAI_COMPATIBLE_BASE_URL;
const localModel = process.env.JIGS_TEST_OPENAI_COMPATIBLE_MODEL;
const localConfigured =
  baseUrl !== undefined && baseUrl !== "" && localModel !== undefined && localModel !== "";
const localReachable = localConfigured
  ? await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

function hasOpenaiCodexLogin(): boolean {
  const authPath = realPiAuthPath();
  if (!existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
    return typeof auth === "object" && auth !== null && "openai-codex" in auth;
  } catch {
    return false;
  }
}

const answer = z.object({ word: z.string(), count: z.number() });

test.skipIf(!localConfigured || !localReachable)(
  "Pi asks an LM Studio OpenAI-compatible model for text and structured output",
  async () => {
    const model = models.openaiCompatible({
      name: "lmstudio",
      baseUrl: baseUrl as string,
      model: localModel as string,
    });
    const plain = await askAgent(
      { harness: harnesses.pi(model), prompt: "Reply with exactly PONG." },
      (wire) => executeAgent(wire, { workflowRunId: `live-pi-local-plain-${crypto.randomUUID()}` }),
    );
    const structured = await askAgent(
      {
        harness: harnesses.pi(model),
        prompt: "Return the word sky and the number 3.",
        output: answer,
      },
      (wire) => executeAgent(wire, { workflowRunId: `live-pi-local-json-${crypto.randomUUID()}` }),
    );
    expect(plain.text.toUpperCase()).toContain("PONG");
    expect(structured.output).toEqual({ word: "sky", count: 3 });
  },
);

test.skipIf(!hasOpenaiCodexLogin())(
  "Pi asks OpenAI Codex gpt-5.5 for text and structured output",
  async () => {
    const model = models.openaiCodex("gpt-5.5");
    const plain = await askAgent(
      { harness: harnesses.pi(model, { thinking: "low" }), prompt: "Reply with exactly PONG." },
      (wire) => executeAgent(wire, { workflowRunId: `live-pi-codex-plain-${crypto.randomUUID()}` }),
    );
    const structured = await askAgent(
      {
        harness: harnesses.pi(model, { thinking: "low" }),
        prompt: "Return the word sky and the number 3.",
        output: answer,
      },
      (wire) => executeAgent(wire, { workflowRunId: `live-pi-codex-json-${crypto.randomUUID()}` }),
    );
    expect(plain.text.toUpperCase()).toContain("PONG");
    expect(structured.output).toEqual({ word: "sky", count: 3 });
  },
);
