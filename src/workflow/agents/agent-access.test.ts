import { expect, expectTypeOf, test } from "vitest";
import { type AskableHarness, harnesses, models } from "./harness-config.ts";
import { linearMcp } from "./linear-mcp.ts";
import { pagerdutyMcp } from "./pagerduty-mcp.ts";
import { buildAskAgentRequest } from "./plan.ts";

test("a harness opts in to Linear and PagerDuty as plain data", () => {
  expect(harnesses.codex({ model: "m", linear: true, pagerduty: true })).toEqual({
    kind: "codex",
    model: "m",
    linear: true,
    pagerduty: true,
  });
  expect(harnesses.pi(models.openaiCodex("m"), { linear: true }).linear).toBe(true);
});

test("a harness with provider access is not one askAgent can run", () => {
  const harness = harnesses.claude({ model: "opus", pagerduty: true });
  expectTypeOf(harness).not.toExtend<AskableHarness>();
  expect(() =>
    buildAskAgentRequest({ harness: harness as unknown as AskableHarness, prompt: "p" }),
  ).toThrow("pagerduty");
});

test("linearMcp reaches Linear's hosted server with the agent's Linear token", () => {
  expect(linearMcp()).toEqual({
    url: "https://mcp.linear.app/mcp",
    bearerTokenEnv: "JIGS_LINEAR_TOKEN",
    probe: { tool: "list_teams", arguments: { limit: 1 } },
  });
  expect(linearMcp({ tools: ["get_issue", "list_teams"] }).tools).toEqual([
    "list_teams",
    "get_issue",
  ]);
});

test("pagerdutyMcp reaches the hosted server with the agent's token, without the user tool", () => {
  expect(pagerdutyMcp()).toEqual({
    url: "https://mcp.pagerduty.com/mcp",
    bearerTokenEnv: "JIGS_PAGERDUTY_TOKEN",
    disabledTools: ["get_user_data"],
    probe: { tool: "list_incidents", arguments: { limit: 1 } },
  });
  const pi = pagerdutyMcp({ tools: ["get_incident"] });
  expect(pi.tools).toEqual(["list_incidents", "get_incident"]);
  expect(pi).not.toHaveProperty("disabledTools");
});

test("each helper is only valid on a harness that opts in to its provider", () => {
  expect(() =>
    harnesses.claude({ model: "opus", linear: true, mcpServers: { linear: linearMcp() } }),
  ).not.toThrow();
  expect(() => harnesses.claude({ model: "opus", mcpServers: { linear: linearMcp() } })).toThrow(
    "MCP server 'linear' reads JIGS_LINEAR_TOKEN",
  );
  expect(() =>
    harnesses.codex({ model: "m", linear: true, mcpServers: { pd: pagerdutyMcp() } }),
  ).toThrow("whose harness sets pagerduty");
  expect(() =>
    harnesses.pi(models.openaiCodex("m"), {
      pagerduty: true,
      mcpServers: { pd: pagerdutyMcp({ tools: [] }) },
    }),
  ).not.toThrow();
  // A hand-written server handed the token counts too.
  expect(() =>
    harnesses.claude({
      model: "opus",
      mcpServers: {
        own: { command: "srv", env: { TOKEN: "JIGS_PAGERDUTY_TOKEN" }, probe: { tool: "x" } },
      },
    }),
  ).toThrow("pagerduty");
});
