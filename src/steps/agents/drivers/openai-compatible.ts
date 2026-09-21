import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { OpenaiCompatibleSource } from "../../../blocks/agents/harness-config.ts";
import type { AgentRequest, ModelRequest } from "../../../blocks/agents/plan.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "../../../checks/core.ts";
import { modelApiKeyCheck, openaiCompatibleRuntimeCheck } from "../../../checks/models.ts";
import { JigsError } from "../../../errors.ts";
import type { Driver, DriverContext } from "./types.ts";

function descriptor(request?: AgentRequest | ModelRequest): OpenaiCompatibleSource | undefined {
  if (request === undefined || !("model" in request) || request.model.kind !== "openai-compatible")
    return undefined;
  return request.model;
}

async function ask(request: AgentRequest | ModelRequest, context: DriverContext) {
  const source = descriptor(request);
  if (source === undefined)
    throw new JigsError("the OpenAI-compatible driver requires an OpenAI-compatible model request");

  const apiKey = source.apiKeyEnv === undefined ? undefined : context.env[source.apiKeyEnv];
  if (source.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === "")) {
    throw new JigsError(
      `${source.apiKeyEnv} is not set in the service's environment`,
      `set ${source.apiKeyEnv} in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
    );
  }

  const provider = createOpenAICompatible({
    baseURL: source.baseUrl,
    name: source.name,
    ...(apiKey === undefined ? {} : { apiKey }),
    supportsStructuredOutputs: true,
    ...source.compat,
  });
  return context.deps.generateText({
    model: provider.chatModel(source.model),
    prompt: request.prompt,
    ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
    ...(context.output === undefined ? {} : { output: context.output }),
  });
}

export const openaiCompatibleDriver = {
  kind: "openai-compatible",
  family: "model",
  ask,
  runtimeChecks: (request?: AgentRequest | ModelRequest) => {
    const source = descriptor(request);
    return source === undefined ? [] : [openaiCompatibleRuntimeCheck(source)];
  },
  authChecks: (request?: AgentRequest | ModelRequest) => {
    const variable = descriptor(request)?.apiKeyEnv;
    return variable === undefined ? [] : [modelApiKeyCheck(variable)];
  },
  envAllowlist: (request?: AgentRequest | ModelRequest) => {
    const variable = descriptor(request)?.apiKeyEnv;
    return variable === undefined ? [] : [variable];
  },
  docsAnchor: "openai-compatible",
  displayName: "OpenAI-compatible",
  cost: () => undefined,
} satisfies Driver<"openai-compatible">;
