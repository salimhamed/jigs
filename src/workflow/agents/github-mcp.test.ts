import { expect, expectTypeOf, test } from "vitest";
import { githubMcp } from "./github-mcp.ts";
import { type AskableHarness, harnesses, models } from "./harness-config.ts";
import { buildAskAgentRequest } from "./plan.ts";
import { describeHarness } from "./result.ts";

test("a harness opts in to GitHub as plain data that counts toward its identity", () => {
  const builder = harnesses.codex({ model: "gpt-5.5", github: true });
  expect(builder).toEqual({ kind: "codex", model: "gpt-5.5", github: true });
  expect(harnesses.claude({ model: "opus", github: { owner: "acme" } }).github).toEqual({
    owner: "acme",
  });
  expect(harnesses.pi(models.openaiCodex("gpt-5.5"), { github: true }).github).toBe(true);
  expect(describeHarness(builder)).not.toBe(describeHarness(harnesses.codex({ model: "gpt-5.5" })));
});

test("a harness with GitHub access is not one askAgent can run", () => {
  const harness = harnesses.claude({ model: "opus", github: true });
  expectTypeOf(harness).not.toExtend<AskableHarness>();
  expect(() =>
    buildAskAgentRequest({ harness: harness as unknown as AskableHarness, prompt: "p" }),
  ).toThrow("github");
});

test("githubMcp runs the local server with the agent's token and without the user tools", () => {
  const server = githubMcp();
  expect(server).toMatchObject({
    command: "github-mcp-server",
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "GH_TOKEN" },
    probe: { tool: "search_repositories" },
  });
  const toolsets = server.args?.find((arg) => arg.startsWith("--toolsets="));
  expect(toolsets?.split("=")[1]?.split(",")).not.toContain("context");
  expect(server).not.toHaveProperty("tools");
});

test("githubMcp for Pi allows the named tools and the probe tool", () => {
  expect(githubMcp({ tools: ["pull_request_read"] }).tools).toEqual([
    "search_repositories",
    "pull_request_read",
  ]);
  expect(() =>
    harnesses.pi(models.openaiCodex("gpt-5.5"), {
      github: true,
      mcpServers: { github: githubMcp({ tools: ["issue_read"] }) },
    }),
  ).not.toThrow();
});

test("githubMcp is only valid on a harness that sets github", () => {
  expect(() =>
    harnesses.claude({ model: "opus", github: true, mcpServers: { github: githubMcp() } }),
  ).not.toThrow();
  expect(() => harnesses.claude({ model: "opus", mcpServers: { github: githubMcp() } })).toThrow(
    "MCP server 'github' reads GH_TOKEN",
  );
  expect(() => harnesses.codex({ model: "gpt-5.5", mcpServers: { gh: githubMcp() } })).toThrow(
    "github",
  );
  expect(() =>
    harnesses.pi(models.openaiCodex("gpt-5.5"), {
      mcpServers: { github: githubMcp({ tools: ["issue_read"] }) },
    }),
  ).toThrow("github");
  // Any server handed the agent's token counts, however it is written.
  expect(() =>
    harnesses.claude({
      model: "opus",
      mcpServers: {
        hosted: {
          url: "https://api.githubcopilot.com/mcp/",
          bearerTokenEnv: "GH_TOKEN",
          probe: { tool: "x" },
        },
      },
    }),
  ).toThrow("github");
});
