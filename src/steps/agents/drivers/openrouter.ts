import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { OpenrouterSource } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest, ModelRequest } from "../../../blocks/agents/plan.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "../../../checks/core.ts";
import { modelApiKeyCheck } from "../../../checks/models.ts";
import { JigsError } from "../../../errors.ts";
import type { Driver, DriverContext } from "./types.ts";

const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";

function descriptor(request?: AgentRequest | ModelRequest): OpenrouterSource | undefined {
  if (request === undefined || !("model" in request) || request.model.kind !== "openrouter")
    return undefined;
  return request.model;
}

function apiKeyEnv(request?: AgentRequest | ModelRequest): string {
  return descriptor(request)?.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
}

async function ask(request: AgentRequest | ModelRequest, context: DriverContext) {
  const source = descriptor(request);
  if (source === undefined)
    throw new JigsError("the OpenRouter driver requires an OpenRouter model request");
  const variable = source.apiKeyEnv;
  const apiKey = context.env[variable];
  if (apiKey === undefined || apiKey === "") {
    throw new JigsError(
      `${variable} is not set in the service's environment`,
      `set ${variable} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
    );
  }

  const openrouter = createOpenRouter({
    apiKey,
    headers: {
      "HTTP-Referer": "https://github.com/salimhamed/jigs",
      "X-Title": "jigs",
    },
  });
  return context.deps.generateText({
    model: openrouter(source.model),
    prompt: request.prompt,
    ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
    ...(context.output === undefined ? {} : { output: context.output }),
    providerOptions: { openrouter: { usage: { include: true } } },
  });
}

export const openrouterDriver = {
  kind: "openrouter",
  family: "model",
  ask,
  runtimeChecks: () => [],
  authChecks: (request?: AgentRequest | ModelRequest) => [modelApiKeyCheck(apiKeyEnv(request))],
  envAllowlist: (request?: AgentRequest | ModelRequest) => [apiKeyEnv(request)],
  docsAnchor: "openrouter",
  displayName: "OpenRouter",
  cost: (generation) => {
    const usage = generation.providerMetadata?.openrouter?.usage;
    if (typeof usage !== "object" || usage === null) return undefined;
    const cost = (usage as { cost?: unknown }).cost;
    return typeof cost === "number" ? cost : undefined;
  },
} satisfies Driver<"openrouter">;
