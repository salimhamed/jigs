import { currentFactoryContext } from "../config/factory-context.ts";
import { type EnvLookup, RESTART_SERVICE, SERVICE_ENV_FILE } from "../providers/credentials.ts";
import type { OpenaiCompatibleSource } from "../workflow/agents/harness-config.ts";
import { PROBE_TIMEOUT_MS } from "./catalog.ts";
import type { Check, CheckResult } from "./check.ts";

const factorySetting: EnvLookup = (name) => currentFactoryContext().env(name);

/** Check that a model API credential is present without spending a request. */
export function modelApiKeyCheck(variable: string, env: EnvLookup = factorySetting): Check {
  return {
    id: `model.${variable.toLowerCase().replaceAll("_", "-")}`,
    label: `${variable} credential`,
    run: async (): Promise<CheckResult> => {
      const credential = env(variable);
      return credential === undefined || credential.trim() === ""
        ? {
            ok: false,
            reason: `${variable} is not set in the service's environment`,
            repair: `set ${variable} in ${SERVICE_ENV_FILE}, then: \`${RESTART_SERVICE}\``,
          }
        : { ok: true };
    },
  };
}

type OpenaiCompatibleCheckDependencies = {
  fetch?: typeof fetch;
  env?: EnvLookup;
};

function availableModels(ids: string[]): string {
  const shown = ids.slice(0, 5);
  const rest = ids.length - shown.length;
  return rest === 0 ? shown.join(", ") : `${shown.join(", ")}, and ${rest} more`;
}

/** Check that an OpenAI-compatible endpoint is reachable and serves the configured model. */
export function openaiCompatibleRuntimeCheck(
  source: OpenaiCompatibleSource,
  dependencies: OpenaiCompatibleCheckDependencies = {},
): Check {
  const request = dependencies.fetch ?? fetch;
  const env = dependencies.env ?? factorySetting;
  const endpoint = `${source.baseUrl.replace(/\/$/, "")}/models`;
  return {
    id: `model.openai-compatible-${source.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
    label: `${source.name} model endpoint`,
    run: async (): Promise<CheckResult> => {
      const credential = source.apiKeyEnv === undefined ? undefined : env(source.apiKeyEnv);
      let response: Response;
      try {
        response = await request(endpoint, {
          method: "GET",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          ...(credential === undefined || credential.trim() === ""
            ? {}
            : { headers: { Authorization: `Bearer ${credential}` } }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          reason: `${source.name} is unreachable at ${endpoint}: ${message}`,
          repair: `start ${source.name} and make its OpenAI-compatible API available at ${source.baseUrl}`,
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          ok: false,
          reason: `${source.name} returned an unreadable model list from ${endpoint}`,
          repair: `confirm ${source.baseUrl} serves an OpenAI-compatible /v1 API`,
        };
      }
      const data =
        typeof body === "object" &&
        body !== null &&
        Array.isArray((body as { data?: unknown }).data)
          ? (body as { data: unknown[] }).data
          : [];
      const ids = data.flatMap((item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string"
          ? [(item as { id: string }).id]
          : [],
      );
      if (!ids.includes(source.model)) {
        const listed = ids.length === 0 ? "no models" : availableModels(ids);
        return {
          ok: false,
          reason: `${source.name} does not serve ${source.model}; ${endpoint} lists ${listed}`,
          repair: `load ${source.model} in ${source.name} or choose one of the models the endpoint serves`,
        };
      }
      return { ok: true, detail: `${endpoint} serves ${source.model}` };
    },
  };
}
