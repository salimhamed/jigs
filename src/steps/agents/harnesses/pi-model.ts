import type {
  OpenaiCompatibleSource,
  PiHarness,
  PiOpenaiCompatibleOptions,
} from "../../../blocks/agents/harness-config.ts";

type PiCredential = { sourceEnv: string; targetEnv: string };
type PiModels = {
  providers: Record<
    string,
    {
      baseUrl: string;
      api: "openai-completions";
      apiKey: string;
      compat: PiOpenaiCompatibleOptions;
      models: Array<{
        id: string;
        cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
      }>;
    }
  >;
};

/** The Pi-specific execution settings translated from one public model descriptor. */
export type PiModelPlan = {
  provider: string;
  model: string;
  credential?: PiCredential;
  models?: PiModels;
  runtimeSource?: OpenaiCompatibleSource;
  subscriptionAuth: boolean;
};

/** Translate one model descriptor into every provider-specific setting Pi needs. */
export function planPiModel(harness: PiHarness): PiModelPlan {
  const source = harness.model;
  switch (source.kind) {
    case "openrouter":
      return {
        provider: "openrouter",
        model: source.model,
        credential: { sourceEnv: source.apiKeyEnv, targetEnv: "OPENROUTER_API_KEY" },
        subscriptionAuth: false,
      };
    case "openai-compatible": {
      const compat = harness.compat;
      if (compat === undefined)
        throw new Error("Pi OpenAI-compatible models require compatibility settings");
      return {
        provider: source.name,
        model: source.model,
        ...(source.apiKeyEnv === undefined
          ? {}
          : {
              credential: { sourceEnv: source.apiKeyEnv, targetEnv: source.apiKeyEnv },
            }),
        models: {
          providers: {
            [source.name]: {
              baseUrl: source.baseUrl,
              api: "openai-completions",
              apiKey: source.apiKeyEnv === undefined ? "jigs" : `$${source.apiKeyEnv}`,
              compat,
              models: [
                {
                  id: source.model,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        runtimeSource: source,
        subscriptionAuth: false,
      };
    }
    case "openai-codex":
      return {
        provider: "openai-codex",
        model: source.model,
        subscriptionAuth: true,
      };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}
