import { expect, onTestFinished, test } from "vitest";
import { inTestFactory, removeTmpDir, useTestFactory } from "../test-fixtures.ts";
import { harnesses } from "../workflow/agents/harness-config.ts";
import { linearMcp } from "../workflow/agents/linear-mcp.ts";
import { pagerdutyMcp } from "../workflow/agents/pagerduty-mcp.ts";
import { doctorChecks, preflightChecks } from "./index.ts";

inTestFactory();

test("preflight checks the installations of each provider a workflow's agents opt in to", () => {
  const ids = (harness: ReturnType<typeof harnesses.codex>) =>
    preflightChecks({ agents: { agent: harness } }).map((check) => check.id);
  expect(ids(harnesses.codex({ model: "m", linear: { installationName: "acme" } }))).toContain(
    "linear.installations",
  );
  expect(ids(harnesses.codex({ model: "m", pagerduty: { installationName: "acme" } }))).toContain(
    "pagerduty.installations",
  );
  expect(ids(harnesses.codex({ model: "m" }))).not.toContain("linear.installations");
  // Declared as an integration too, each provider is still checked once.
  const both = preflightChecks({
    integrations: ["linear"],
    agents: { agent: harnesses.codex({ model: "m", linear: { installationName: "acme" } }) },
  }).filter((check) => check.id === "linear.installations");
  expect(both).toHaveLength(1);
});

test("doctor leaves a hosted server reading an agent token to the step's own probe", () => {
  const parent = useTestFactory("export default { hub: { url: 'https://hub.example.test' } }");
  onTestFinished(() => removeTmpDir(parent));
  const triager = harnesses.claude({
    model: "m",
    linear: { installationName: "acme" },
    pagerduty: { installationName: "acme" },
    mcpServers: { linear: linearMcp(), pagerduty: pagerdutyMcp() },
  });
  const ids = doctorChecks({ triage: { requires: { agents: { triager } } } }).map(
    (check) => check.id,
  );
  expect(ids).toEqual(expect.arrayContaining(["linear.installations", "pagerduty.installations"]));
  expect(ids.filter((id) => id.startsWith("mcp."))).toEqual([]);
});
