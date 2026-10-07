import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { type FactoryContext, resolveFactoryContext } from "../config/factory-context.ts";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { harnesses } from "../workflow/agents/harness-config.ts";
import { linearMcp } from "../workflow/agents/linear-mcp.ts";
import { pagerdutyMcp } from "../workflow/agents/pagerduty-mcp.ts";
import { runChecks } from "./catalog.ts";
import type { WorkflowRequires } from "./index.ts";
import { doctorSecretChecks, secretChecks } from "./secrets.ts";

function factoryWithEnv(dotEnv: string): FactoryContext {
  const root = makeTmpDir();
  onTestFinished(() => removeTmpDir(root));
  writeFileSync(path.join(root, ".env"), dotEnv);
  return resolveFactoryContext(root);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function outcomes(requires: WorkflowRequires, shell: Record<string, string>, dotEnv = "") {
  for (const [name, value] of Object.entries(shell)) vi.stubEnv(name, value);
  const report = await runChecks(secretChecks(requires, { context: factoryWithEnv(dotEnv) }));
  return report.checks;
}

test("a declared secret that is not set fails with the .env repair", async () => {
  expect(await outcomes({ secrets: ["SNOWFLAKE_TOKEN"] }, {})).toEqual([
    {
      id: "secret.SNOWFLAKE_TOKEN",
      label: "secret SNOWFLAKE_TOKEN",
      ok: false,
      reason: "SNOWFLAKE_TOKEN is not set in the service's environment",
      repair:
        "set SNOWFLAKE_TOKEN in the factory repo's .env, then: `pnpm exec jigs service restart`",
    },
  ]);
});

test("an empty secret counts as unset", async () => {
  const [check] = await outcomes({ secrets: ["SNOWFLAKE_TOKEN"] }, { SNOWFLAKE_TOKEN: " " });
  expect(check).toMatchObject({ ok: false });
});

test("a secret set in .env passes without a detail", async () => {
  const [check] = await outcomes(
    { secrets: ["SNOWFLAKE_TOKEN"] },
    { SNOWFLAKE_TOKEN: "from-env-file" },
    "SNOWFLAKE_TOKEN=from-env-file\n",
  );
  expect(check).toEqual({
    id: "secret.SNOWFLAKE_TOKEN",
    label: "secret SNOWFLAKE_TOKEN",
    ok: true,
  });
});

test("a secret only the shell provides passes, saying so without its value", async () => {
  for (const dotEnv of ["", "SNOWFLAKE_TOKEN=\n", 'SNOWFLAKE_TOKEN="  "\n']) {
    const [check] = await outcomes(
      { secrets: ["SNOWFLAKE_TOKEN"] },
      { SNOWFLAKE_TOKEN: "shell-value" },
      dotEnv,
    );
    expect(check).toMatchObject({
      ok: true,
      detail: "not set in .env; the service has it from the shell or an earlier .env",
    });
    expect(JSON.stringify(check)).not.toContain("shell-value");
  }
});

test("an entry that is not a variable name fails by position, without echoing it", async () => {
  const checks = await outcomes(
    { secrets: ["GOOD_NAME", "sk-live-123", "lower"] },
    { GOOD_NAME: "x" },
  );
  expect(checks[0]).toMatchObject({
    id: "secret.entries",
    ok: false,
    reason:
      "entries 2, 3 of requires.secrets are not environment variable names (uppercase letters, digits and underscores)",
  });
  expect(JSON.stringify(checks)).not.toContain("sk-live-123");
  expect(checks.map((check) => check.id)).toEqual(["secret.entries", "secret.GOOD_NAME"]);
});

test("the variables an agent's MCP servers name are checked without being listed", async () => {
  const requires: WorkflowRequires = {
    agents: {
      analyst: harnesses.claude({
        model: "sonnet",
        mcpServers: {
          warehouse: {
            url: "https://mcp.example.com",
            bearerTokenEnv: "WAREHOUSE_TOKEN",
            probe: { tool: "ping" },
          },
          local: {
            command: "server",
            env: { API_KEY: "LOCAL_API_KEY" },
            probe: { tool: "ping" },
          },
        },
      }),
    },
    secrets: ["WAREHOUSE_TOKEN"],
  };
  const checks = await outcomes(requires, {});
  expect(checks.map((check) => check.id)).toEqual([
    "secret.WAREHOUSE_TOKEN",
    "secret.LOCAL_API_KEY",
  ]);
});

test("doctor checks each name once and names every workflow that needs it", async () => {
  const report = await runChecks(
    doctorSecretChecks(
      {
        hello: {},
        sync: { requires: { secrets: ["SNOWFLAKE_TOKEN"] } },
        report: { requires: { secrets: ["SNOWFLAKE_TOKEN", "bad name"] } },
      },
      { context: factoryWithEnv("") },
    ),
  );
  expect(report.checks).toEqual([
    expect.objectContaining({
      id: "secret.entries.report",
      reason:
        "entry 2 of workflow report's requires.secrets is not an environment variable name (uppercase letters, digits and underscores)",
    }),
    expect.objectContaining({
      id: "secret.SNOWFLAKE_TOKEN",
      reason:
        "SNOWFLAKE_TOKEN is not set in the service's environment (needed by workflows sync, report)",
    }),
  ]);
});

test("without a factory .env a set secret still passes", async () => {
  vi.stubEnv("SNOWFLAKE_TOKEN", "x");
  const [check] = await runChecks(
    secretChecks(
      { secrets: ["SNOWFLAKE_TOKEN"] },
      { context: resolveFactoryContext(path.join(makeTmpDir(), "no-factory")) },
    ),
  ).then((report) => report.checks);
  expect(check).toMatchObject({ ok: true });
});

test("doctor leaves MCP credentials to the MCP server checks", () => {
  const analyst = harnesses.claude({
    model: "sonnet",
    mcpServers: {
      warehouse: {
        url: "https://mcp.example.com",
        bearerTokenEnv: "WAREHOUSE_TOKEN",
        probe: { tool: "ping" },
      },
    },
  });
  const checks = doctorSecretChecks(
    { analysis: { requires: { agents: { analyst } } } },
    { context: factoryWithEnv("") },
  );
  expect(checks).toEqual([]);
});

test("the agent tokens jigs mints for an opted-in harness are not asked of the service", async () => {
  const requires: WorkflowRequires = {
    agents: {
      triager: harnesses.claude({
        model: "sonnet",
        linear: { installationName: "linear-test" },
        pagerduty: { installationName: "pagerduty-test" },
        mcpServers: {
          linear: linearMcp(),
          pagerduty: pagerdutyMcp(),
          warehouse: {
            url: "https://mcp.example.com",
            bearerTokenEnv: "WAREHOUSE_TOKEN",
            probe: { tool: "ping" },
          },
        },
      }),
    },
  };
  const checks = await outcomes(requires, {});
  expect(checks.map((check) => check.id)).toEqual(["secret.WAREHOUSE_TOKEN"]);
});
