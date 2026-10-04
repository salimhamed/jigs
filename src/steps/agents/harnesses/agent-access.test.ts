import { expect, test, vi } from "vitest";
import { githubMcp } from "../../../workflow/agents/github-mcp.ts";
import { type Harness, harnesses } from "../../../workflow/agents/harness-config.ts";
import { linearMcp } from "../../../workflow/agents/linear-mcp.ts";
import { type AgentAccessDeps, agentAccessEnv } from "./agent-access.ts";

function deps() {
  const fake = {
    github: vi.fn(
      async ({ harness }: { harness: Harness }): Promise<Record<string, string>> =>
        harness.github === undefined ? {} : { GH_TOKEN: "ghs" },
    ),
    linearToken: vi.fn(async () => "lin_token"),
    pagerdutyToken: vi.fn(async () => "pd_token"),
  } satisfies AgentAccessDeps;
  return fake;
}

const envFor = (harness: Harness, fake: AgentAccessDeps) =>
  agentAccessEnv({ harness, cwd: "/w" }, {}, fake);

test("a harness that opts in to nothing gets nothing and mints nothing", async () => {
  const fake = deps();
  expect(await envFor(harnesses.claude({ model: "m" }), fake)).toEqual({});
  expect(fake.linearToken).not.toHaveBeenCalled();
  expect(fake.pagerdutyToken).not.toHaveBeenCalled();
});

test("each opt-in adds its provider's token under its own name", async () => {
  const fake = deps();
  const harness = harnesses.codex({ model: "m", github: true, linear: true, pagerduty: true });
  expect(await envFor(harness, fake)).toEqual({
    GH_TOKEN: "ghs",
    JIGS_LINEAR_TOKEN: "lin_token",
    JIGS_PAGERDUTY_TOKEN: "pd_token",
  });
  expect(await envFor(harnesses.codex({ model: "m", linear: true }), fake)).toEqual({
    JIGS_LINEAR_TOKEN: "lin_token",
  });
});

test("a server reading an agent token on a harness without the opt-in fails the step", async () => {
  const fake = deps();
  const github = { kind: "claude", model: "m", mcpServers: { github: githubMcp() } } as const;
  await expect(envFor(github, fake)).rejects.toThrow("MCP server 'github' reads GH_TOKEN");
  const linear = { kind: "claude", model: "m", mcpServers: { linear: linearMcp() } } as const;
  await expect(envFor(linear, fake)).rejects.toThrow("reads JIGS_LINEAR_TOKEN");
  expect(fake.linearToken).not.toHaveBeenCalled();
});
