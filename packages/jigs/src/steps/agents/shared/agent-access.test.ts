import { expect, test, vi } from "vitest";
import { githubMcp } from "../../../workflow/agents/github-mcp.ts";
import { type Harness, harnesses } from "../../../workflow/agents/harness-config.ts";
import { linearMcp } from "../../../workflow/agents/linear-mcp.ts";
import { type AgentAccessDeps, agentAccessEnv } from "./agent-access.ts";

function deps() {
  const fake = {
    github: vi.fn(
      async (harness: Harness): Promise<Record<string, string>> =>
        harness.github === undefined ? {} : { GH_TOKEN: "ghs" },
    ),
    token: vi.fn(
      async (provider: "linear" | "pagerduty", installationName: string) =>
        `${provider}:${installationName}`,
    ),
  } satisfies AgentAccessDeps;
  return fake;
}

const envFor = (harness: Harness, fake: AgentAccessDeps) => agentAccessEnv(harness, {}, fake);

test("a harness that opts in to nothing gets nothing and mints nothing", async () => {
  const fake = deps();
  expect(await envFor(harnesses.claude({ model: "m" }), fake)).toEqual({});
  expect(fake.token).not.toHaveBeenCalled();
});

test("each opt-in adds the token of the installation it names under its provider's name", async () => {
  const fake = deps();
  const harness = harnesses.codex({
    model: "m",
    github: { installationName: "github-acme" },
    linear: { installationName: "linear-acme" },
    pagerduty: { installationName: "pd-acme" },
  });
  expect(await envFor(harness, fake)).toEqual({
    GH_TOKEN: "ghs",
    JIGS_LINEAR_TOKEN: "linear:linear-acme",
    JIGS_PAGERDUTY_TOKEN: "pagerduty:pd-acme",
  });
  expect(
    await envFor(harnesses.codex({ model: "m", linear: { installationName: "other" } }), fake),
  ).toEqual({ JIGS_LINEAR_TOKEN: "linear:other" });
});

test("a server reading an agent token on a harness without the opt-in fails the step", async () => {
  const fake = deps();
  const github = { kind: "claude", model: "m", mcpServers: { github: githubMcp() } } as const;
  await expect(envFor(github, fake)).rejects.toThrow("MCP server 'github' reads GH_TOKEN");
  const linear = { kind: "claude", model: "m", mcpServers: { linear: linearMcp() } } as const;
  await expect(envFor(linear, fake)).rejects.toThrow("reads JIGS_LINEAR_TOKEN");
  expect(fake.token).not.toHaveBeenCalled();
});
