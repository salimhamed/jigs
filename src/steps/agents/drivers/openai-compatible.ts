import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { modelApiKeyCheck, openaiCompatibleRuntimeCheck } from "../../../checks/models.ts";
import { JigsError } from "../../../errors.ts";
import type { OpenaiCompatibleSource } from "../../../workflow/agents/harness-config.ts";
import type { AgentRequest, ModelRequest } from "../../../workflow/agents/plan.ts";
import type { Driver, DriverContext, DriverRequest } from "./types.ts";

function descriptor(request: DriverRequest): OpenaiCompatibleSource | undefined {
  if (!("model" in request) || request.model.kind !== "openai-compatible") return undefined;
  return request.model;
}

async function ask(request: AgentRequest | ModelRequest, context: DriverContext) {
  const source = descriptor(request);
  if (source === undefined)
    throw new JigsError("the OpenAI-compatible driver requires an OpenAI-compatible model request");

  const apiKey = source.apiKeyEnv === undefined ? undefined : context.env[source.apiKeyEnv];
  const provider = createOpenAICompatible({
    baseURL: source.baseUrl,
    name: source.name,
    ...(apiKey === undefined ? {} : { apiKey }),
    supportsStructuredOutputs: true,
  });
  return context.deps.generateText({
    model: provider.chatModel(source.model),
    prompt: request.prompt,
    ...("system" in request && request.system !== undefined ? { system: request.system } : {}),
    ...(context.output === undefined ? {} : { output: context.output }),
  });
}

function descriptorChecks(source: OpenaiCompatibleSource) {
  return [
    openaiCompatibleRuntimeCheck(source),
    ...(source.apiKeyEnv === undefined ? [] : [modelApiKeyCheck(source.apiKeyEnv)]),
  ];
}

export const openaiCompatibleDriver = {
  kind: "openai-compatible",
  family: "model",
  ask,
  installationChecks: () => [],
  descriptorChecks,
  requestChecks: (request) => {
    const source = descriptor(request);
    return source === undefined ? [] : descriptorChecks(source);
  },
  envAllowlist: (request: DriverRequest) => {
    const variable = descriptor(request)?.apiKeyEnv;
    return variable === undefined ? [] : [variable];
  },
  docsAnchor: "openai-compatible",
  displayName: "OpenAI-compatible",
} satisfies Driver<"openai-compatible">;
