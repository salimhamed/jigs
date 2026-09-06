// The provider seam. Everything downstream takes a plain LanguageModel and
// reads the credential's name off SLACK_MODEL_CREDENTIAL, so pointing a
// factory at a local OpenAI-compatible endpoint is a change to this file, the
// .env template and the jigs.yml comment — no gate, tool, check or prompt
// moves with it.

// Static, not a dynamic import: see the note in connection.ts — the e2e boot
// stage is what proves a `link:`-installed factory resolves this package.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/** The one credential the agent's model calls are billed to: what it is
 *  called in the factory's .env, the prefix that says a key came from the
 *  right dashboard, and the vendor to name in repair text. */
export const SLACK_MODEL_CREDENTIAL = {
  env: "OPENROUTER_API_KEY",
  prefix: "sk-or-",
  provider: "OpenRouter",
  where: "https://openrouter.ai/keys",
} as const;

export function resolveSlackModel(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  // Passed explicitly rather than left to the provider's own env read: the
  // key this service was started with is the one that pays, and an injected
  // env has to be able to say so.
  const apiKey = env[SLACK_MODEL_CREDENTIAL.env];
  return createOpenRouter(apiKey === undefined ? {} : { apiKey })(modelId);
}

// Verified 2026-09-06: 200 with or without an Authorization header, one page
// (`links.next` null at 431 models), and the ids include the `:free`/`:batch`
// variants an operator may well have configured. See
// docs/research/openrouter-ai-sdk-notes.md.
const MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Every model id this provider will serve. Doctor's only way to tell a
 *  typo'd model id from a working one before a thread pays to find out. */
export async function listSlackModelIds(apiKey: string): Promise<string[]> {
  const response = await fetch(MODELS_URL, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`${MODELS_URL} answered ${response.status}`);
  }
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).flatMap((model) =>
    typeof model.id === "string" ? [model.id] : [],
  );
}
