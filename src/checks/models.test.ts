import { expect, test } from "vitest";
import { models } from "../workflow/agents/harness-config.ts";
import { RESTART_SERVICE, SERVICE_ENV_FILE } from "./core.ts";
import { preflightChecks } from "./index.ts";
import { modelApiKeyCheck, openaiCompatibleRuntimeCheck } from "./models.ts";

test("an API model credential check requires the named environment variable without probing", async () => {
  const missing = await modelApiKeyCheck("OPENROUTER_API_KEY", {}).run();
  expect(missing).toEqual({
    ok: false,
    reason: "OPENROUTER_API_KEY is not set in the service's environment",
    repair: `set OPENROUTER_API_KEY in ${SERVICE_ENV_FILE}, then: ${RESTART_SERVICE}`,
  });

  await expect(
    modelApiKeyCheck("TEAM_OPENROUTER_KEY", { TEAM_OPENROUTER_KEY: "configured" }).run(),
  ).resolves.toEqual({ ok: true });
  await expect(
    modelApiKeyCheck("TEAM_OPENROUTER_KEY", { TEAM_OPENROUTER_KEY: "  " }).run(),
  ).resolves.toMatchObject({ ok: false });
});

const source = {
  kind: "openai-compatible" as const,
  name: "north-desktop",
  baseUrl: "http://localhost:1234/v1",
  model: "wanted-model",
};

test("an OpenAI-compatible runtime check confirms the configured model is served", async () => {
  let request: Request | undefined;
  const check = openaiCompatibleRuntimeCheck(source, {
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ data: [{ id: "wanted-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  expect(check.id).toBe("model.openai-compatible-north-desktop");
  await expect(check.run()).resolves.toEqual({
    ok: true,
    detail: "http://localhost:1234/v1/models serves wanted-model",
  });
  expect(request?.method).toBe("GET");
  expect(request?.url).toBe("http://localhost:1234/v1/models");
});

test("an unreachable OpenAI-compatible endpoint has a reachability repair", async () => {
  const check = openaiCompatibleRuntimeCheck(source, {
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });

  await expect(check.run()).resolves.toEqual({
    ok: false,
    reason: "north-desktop is unreachable at http://localhost:1234/v1/models: fetch failed",
    repair:
      "start north-desktop and make its OpenAI-compatible API available at http://localhost:1234/v1",
  });
});

test("an OpenAI-compatible endpoint names a missing model and truncates its available list", async () => {
  const check = openaiCompatibleRuntimeCheck(source, {
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: ["one", "two", "three", "four", "five", "six", "seven"].map((id) => ({ id })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await expect(check.run()).resolves.toEqual({
    ok: false,
    reason:
      "north-desktop does not serve wanted-model; http://localhost:1234/v1/models lists one, two, three, four, five, and 2 more",
    repair: "load wanted-model in north-desktop or choose one of the models the endpoint serves",
  });
});

test("two OpenAI-compatible sources in one workflow get distinct check ids", () => {
  const ids = preflightChecks({
    models: [
      models.openaiCompatible({ name: "desk", baseUrl: "http://desk:1234/v1", model: "a" }),
      models.openaiCompatible({ name: "rack", baseUrl: "http://rack:1234/v1", model: "b" }),
    ],
  }).map((check) => check.id);

  expect(ids).toEqual(["model.openai-compatible-desk", "model.openai-compatible-rack"]);
});
