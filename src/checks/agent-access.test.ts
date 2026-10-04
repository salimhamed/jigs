import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { harnesses } from "../workflow/agents/harness-config.ts";
import { linearMcp } from "../workflow/agents/linear-mcp.ts";
import { pagerdutyMcp } from "../workflow/agents/pagerduty-mcp.ts";
import { runChecks } from "./catalog.ts";
import { doctorChecks, preflightChecks } from "./index.ts";
import { mcpReachableCheck } from "./mcp.ts";

test("preflight checks the identity of each provider a workflow's agents opt in to", () => {
  const ids = (harness: ReturnType<typeof harnesses.codex>) =>
    preflightChecks({ agents: { agent: harness } }).map((check) => check.id);
  expect(ids(harnesses.codex({ model: "m", linear: true }))).toContain("linear.identity");
  expect(ids(harnesses.codex({ model: "m", pagerduty: true }))).toContain("pagerduty.identity");
  expect(ids(harnesses.codex({ model: "m" }))).not.toContain("linear.identity");
  // Declared as an integration too, each identity is still checked once.
  const both = preflightChecks({
    integrations: ["linear"],
    agents: { agent: harnesses.codex({ model: "m", linear: true }) },
  }).filter((check) => check.id === "linear.identity");
  expect(both).toHaveLength(1);
});

test("doctor checks a hosted server reading an agent token is reachable, not probed", () => {
  const factory = makeTmpDir();
  onTestFinished(() => {
    vi.unstubAllEnvs();
    removeTmpDir(factory);
  });
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    "export default { service: { dashboardPort: 9090 } }",
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
  expect(ids).toEqual(
    expect.arrayContaining([
      "linear.identity",
      "pagerduty.identity",
      "mcp.linear",
      "mcp.pagerduty",
    ]),
  );
});

test("a server that answers with any status is reachable", async () => {
  const doFetch = vi.fn(async () => new Response("", { status: 401 }));
  const report = await runChecks([
    mcpReachableCheck("mcp.x", "x", "https://mcp.x.test/mcp", doFetch),
  ]);
  expect(report.ok).toBe(true);
  expect(doFetch).toHaveBeenCalledWith("https://mcp.x.test/mcp", expect.anything());
});

test("a server that does not answer fails with its host", async () => {
  const doFetch = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
  const report = await runChecks([
    mcpReachableCheck("mcp.x", "x", "https://mcp.x.test/mcp", doFetch),
  ]);
  expect(report.checks[0]).toMatchObject({
    ok: false,
    reason: expect.stringContaining("fetch failed"),
    repair: expect.stringContaining("mcp.x.test"),
  });
});
