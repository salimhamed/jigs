import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { inTestFactory, makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { githubMcp } from "../workflow/agents/github-mcp.ts";
import { harnesses } from "../workflow/agents/harness-config.ts";
import { agentGithubChecks } from "./agent-github.ts";
import { runChecks } from "./catalog.ts";
import { doctorChecks, preflightChecks } from "./index.ts";

inTestFactory();

const builder = harnesses.codex({ model: "m", github: { installationName: "acme" } });
const installed = { exec: async () => ({}), factoryEnv: () => [] };

test("no harness opts in, so nothing is checked", () => {
  expect(agentGithubChecks([harnesses.codex({ model: "m" })])).toEqual([]);
});

test("an opted-in harness needs gh", async () => {
  const report = await runChecks(agentGithubChecks([builder], installed));
  expect(report.checks.map((check) => [check.id, check.ok])).toEqual([["agent.gh", true]]);
});

test("a missing gh fails with how to install it", async () => {
  const exec = vi.fn(async () => {
    throw new Error("spawn gh ENOENT");
  });
  const report = await runChecks(agentGithubChecks([builder], { exec, factoryEnv: () => [] }));
  expect(report.checks[0]).toMatchObject({
    id: "agent.gh",
    ok: false,
    repair: expect.stringContaining("cli.github.com"),
  });
  expect(exec).toHaveBeenCalledWith("gh", ["--version"], expect.anything());
});

test("preflight checks a workflow's opted-in agents", () => {
  const ids = (agents: Record<string, ReturnType<typeof harnesses.codex>>) =>
    preflightChecks({ agents }).map((check) => check.id);
  expect(ids({ builder })).toEqual(expect.arrayContaining(["github.installations", "agent.gh"]));
  expect(ids({ builder: harnesses.codex({ model: "m" }) })).not.toContain("agent.gh");
});

test("doctor checks github-mcp-server is installed instead of probing it without a token", () => {
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
  const withMcp = harnesses.claude({
    model: "m",
    github: { installationName: "acme" },
    mcpServers: { github: githubMcp() },
  });
  const checks = doctorChecks({ ship: { requires: { agents: { builder: withMcp } } } });
  const ids = checks.map((check) => check.id);
  expect(ids).toEqual(expect.arrayContaining(["github.installations", "agent.gh", "mcp.github"]));
  expect(checks.find((check) => check.id === "mcp.github")?.label).toBe("MCP server github");
});
