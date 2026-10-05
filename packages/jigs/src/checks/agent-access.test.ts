import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { inTestFactory, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { harnesses } from "../workflow/agents/harness-config.ts";
import { linearMcp } from "../workflow/agents/linear-mcp.ts";
import { pagerdutyMcp } from "../workflow/agents/pagerduty-mcp.ts";
import { doctorChecks, preflightChecks } from "./index.ts";

inTestFactory();

test("preflight checks the identity of each provider a workflow's agents opt in to", () => {
  const ids = (harness: ReturnType<typeof harnesses.codex>) =>
    preflightChecks({ agents: { agent: harness } }).map((check) => check.id);
  expect(ids(harnesses.codex({ model: "m", linear: true }))).toContain("linear.identity");
  expect(ids(harnesses.codex({ model: "m", pagerduty: true }))).toContain("pagerduty.app");
  expect(ids(harnesses.codex({ model: "m" }))).not.toContain("linear.identity");
  // Declared as an integration too, each identity is still checked once.
  const both = preflightChecks({
    integrations: ["linear"],
    agents: { agent: harnesses.codex({ model: "m", linear: true }) },
  }).filter((check) => check.id === "linear.identity");
  expect(both).toHaveLength(1);
});

test("doctor leaves a hosted server reading an agent token to the step's own probe", () => {
  const factory = makeTmpDir();
  onTestFinished(() => {
    vi.unstubAllEnvs();
    removeTmpDir(factory);
  });
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    "export default { hub: { url: 'https://hub.example.test' }, service: { dashboardPort: 9090 } }",
  );
  vi.stubEnv("JIGS_FACTORY_ROOT", factory);
  const triager = harnesses.claude({
    model: "m",
    linear: true,
    pagerduty: true,
    mcpServers: { linear: linearMcp(), pagerduty: pagerdutyMcp() },
  });
  const ids = doctorChecks({ triage: { requires: { agents: { triager } } } }).map(
    (check) => check.id,
  );
  expect(ids).toEqual(expect.arrayContaining(["linear.identity", "pagerduty.app"]));
  expect(ids.filter((id) => id.startsWith("mcp."))).toEqual([]);
});
