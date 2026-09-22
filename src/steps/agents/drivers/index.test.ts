import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { harnesses, models } from "../../../blocks/agents/harness-config.ts";
import { buildAskAgentRequest } from "../../../blocks/agents/plan.ts";
import { driverFor, drivers } from "./index.ts";

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
  for (const driver of Object.values(drivers)) {
    const installationIds = driver.installationChecks().map((check) => check.id);
    expect(driver.envAllowlist()).toBeInstanceOf(Array);
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
    "model.openai-compatible-runtime",
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
