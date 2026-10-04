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

const APP = {
  mode: "app",
  appId: 1,
  installations: { acme: 2 },
  privateKeyPath: "key.pem",
  operator: "me",
} as const;
const builder = harnesses.codex({ model: "m", github: true });
const installed = { exec: async () => ({}), factoryEnv: () => [] };

test("no harness opts in, so nothing is checked", () => {
  expect(agentGithubChecks([harnesses.codex({ model: "m" })])).toEqual([]);
});

test("an opted-in harness needs a GitHub App identity and gh", async () => {
  const report = await runChecks(
    agentGithubChecks([builder], { ...installed, identities: () => [APP] }),
  );
  expect(report.checks.map((check) => [check.id, check.ok])).toEqual([
    ["github.agent-identity", true],
    ["agent.gh", true],
  ]);
});

test("with a personal access token, an opted-in harness fails and says it needs App mode", async () => {
  const report = await runChecks(
    agentGithubChecks([builder], { ...installed, identities: () => [{ mode: "pat" }] }),
  );
  expect(report.checks[0]).toMatchObject({
    id: "github.agent-identity",
    ok: false,
    reason: expect.stringContaining("needs a GitHub App identity"),
  });
});

test("a missing gh fails with how to install it", async () => {
  const exec = vi.fn(async () => {
    throw new Error("spawn gh ENOENT");
  });
  const report = await runChecks(
    agentGithubChecks([builder], { exec, factoryEnv: () => [], identities: () => [APP] }),
  );
  expect(report.checks[1]).toMatchObject({
    id: "agent.gh",
    ok: false,
    repair: expect.stringContaining("cli.github.com"),
  });
  expect(exec).toHaveBeenCalledWith("gh", ["--version"], expect.anything());
});

test("preflight checks a workflow's opted-in agents", () => {
  const ids = (agents: Record<string, ReturnType<typeof harnesses.codex>>) =>
    preflightChecks({ agents }).map((check) => check.id);
  expect(ids({ builder })).toEqual(expect.arrayContaining(["github.agent-identity", "agent.gh"]));
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
    github: true,
    mcpServers: { github: githubMcp() },
  });
  const checks = doctorChecks({ ship: { requires: { agents: { builder: withMcp } } } });
  const ids = checks.map((check) => check.id);
  expect(ids).toEqual(expect.arrayContaining(["github.agent-identity", "agent.gh", "mcp.github"]));
  expect(checks.find((check) => check.id === "mcp.github")?.label).toBe("MCP server github");
});
