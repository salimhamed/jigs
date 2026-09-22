import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { harnesses, models } from "../../../blocks/agents/harness-config.ts";
import { buildAskAgentRequest, buildModelRequest } from "../../../blocks/agents/plan.ts";
import { driverFor, drivers } from "./index.ts";
import type { DriverRequest } from "./types.ts";

const localSource = models.openaiCompatible({
  name: "local",
  baseUrl: "http://localhost:1234/v1",
  model: "local",
});
const contractRequests: Record<keyof typeof drivers, DriverRequest> = {
  claude: buildAskAgentRequest({ harness: harnesses.claude("sonnet"), prompt: "hello" }),
  codex: buildAskAgentRequest({ harness: harnesses.codex("gpt-5.5"), prompt: "hello" }),
  "openai-compatible": buildModelRequest({ model: localSource, prompt: "hello" }),
  openrouter: buildModelRequest({ model: models.openrouter("model"), prompt: "hello" }),
  pi: buildAskAgentRequest({ harness: harnesses.pi(localSource), prompt: "hello" }),
};

test("driver lookup preserves installed kinds and rejects unregistered kinds", () => {
  expect(driverFor("claude")).toBe(drivers.claude);
  expect(driverFor("openrouter")).toBe(drivers.openrouter);
  expect(driverFor("openai-compatible")).toBe(drivers["openai-compatible"]);
  expect(driverFor("pi")).toBe(drivers.pi);
});

test("every registered driver declares its operational contract and documentation", () => {
  const guide = readFileSync(
    new URL("../../../../site/guide/models-and-harnesses.md", import.meta.url),
    "utf8",
  );
  for (const [kind, driver] of Object.entries(drivers)) {
    expect(driver.envAllowlist(contractRequests[kind as keyof typeof drivers])).toBeInstanceOf(
      Array,
    );
    const installationIds = driver.installationChecks().map((check) => check.id);
    if (driver.family === "harness") {
      expect(installationIds).toContain(`harness.${driver.kind}-cli`);
      expect(driver.sessionPointer).toEqual({
        providerKey: expect.any(String),
        field: expect.any(String),
      });
    } else {
      expect("sessionPointer" in driver ? driver.sessionPointer : undefined).toBeUndefined();
    }
    const headings = [...guide.matchAll(/^## (.+)$/gm)].map((match) =>
      match[1]?.toLowerCase().replaceAll(" ", "-"),
    );
    expect(headings).toContain(driver.docsAnchor);
  }
});

test("Pi derives checks and environment from its nested model source", () => {
  const local = buildAskAgentRequest({
    harness: harnesses.pi(
      models.openaiCompatible({
        name: "studio",
        baseUrl: "http://localhost:1234/v1",
        model: "local",
        apiKeyEnv: "STUDIO_TOKEN",
      }),
    ),
    prompt: "hello",
  });
  expect(drivers.pi.installationChecks().map((check) => check.id)).toEqual(["harness.pi-cli"]);
  expect(drivers.pi.requestChecks(local).map((check) => check.id)).toEqual([
    "model.openai-compatible-studio",
    "model.studio-token",
  ]);
  expect(drivers.pi.envAllowlist(local)).toEqual(["STUDIO_TOKEN"]);

  const codex = buildAskAgentRequest({
    harness: harnesses.pi(models.openaiCodex("gpt-5.5")),
    prompt: "hello",
  });
  expect(drivers.pi.requestChecks(codex).map((check) => check.id)).toEqual([
    "harness.pi-openai-codex-auth",
  ]);
});
