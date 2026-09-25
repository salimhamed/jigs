import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { harnesses, harnessKinds, models } from "../../../workflow/agents/harness-config.ts";
import {
  buildAgentRequest,
  buildAskAgentRequest,
  buildModelRequest,
} from "../../../workflow/agents/plan.ts";
import { RESERVED_AGENT_ENV } from "../../../workflow/factory.ts";
import { driverFor, drivers } from "./index.ts";
import type { DriverRequest } from "./types.ts";

const localSource = models.openaiCompatible({
  name: "local",
  baseUrl: "http://localhost:1234/v1",
  model: "local",
});
const contractRequests: Record<keyof typeof drivers, DriverRequest> = {
  claude: buildAskAgentRequest({ harness: harnesses.claude({ model: "sonnet" }), prompt: "hello" }),
  codex: buildAgentRequest({
    harness: harnesses.codex({ model: "gpt-5.5" }),
    cwd: "/work",
    prompt: "hello",
  }),
  "openai-compatible": buildModelRequest({ model: localSource, prompt: "hello" }),
  openrouter: buildModelRequest({ model: models.openrouter("model"), prompt: "hello" }),
  pi: buildAskAgentRequest({ harness: harnesses.pi(localSource), prompt: "hello" }),
};
const docsAnchors: Record<keyof typeof drivers, string> = {
  claude: "claude-code",
  codex: "codex",
  "openai-compatible": "openai-compatible",
  openrouter: "openrouter",
  pi: "pi",
};

test("driver lookup preserves installed kinds and rejects unregistered kinds", () => {
  expect(driverFor("claude")).toBe(drivers.claude);
  expect(driverFor("openrouter")).toBe(drivers.openrouter);
  expect(driverFor("openai-compatible")).toBe(drivers["openai-compatible"]);
  expect(driverFor("pi")).toBe(drivers.pi);
});

test("the harness kinds workflow code names are exactly the registered harness drivers", () => {
  const harnessDrivers = Object.values(drivers)
    .filter((driver) => driver.family === "harness")
    .map((driver) => driver.kind);
  expect([...harnessKinds].sort()).toEqual(harnessDrivers.sort());
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
    expect(headings).toContain(docsAnchors[kind as keyof typeof drivers]);
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

// The contract requests use each source's defaults, so a driver's allowlist
// for them names the default credential variables as well.
test("agents.env reserves every variable a driver sets or reads by default", () => {
  const declared = Object.entries(drivers).flatMap(([kind, driver]) => [
    ...driver.setsEnv,
    ...driver.envAllowlist(contractRequests[kind as keyof typeof drivers]),
  ]);
  expect(declared).toEqual(
    expect.arrayContaining(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR"]),
  );
  expect(declared).toContain(models.openrouter("model").apiKeyEnv);
  for (const name of declared) expect(RESERVED_AGENT_ENV).toContain(name);
});
