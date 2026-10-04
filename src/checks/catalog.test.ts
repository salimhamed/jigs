import { copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { type Harness, harnesses, models } from "../workflow/agents/harness-config.ts";
import { formatFailures, runChecks } from "./catalog.ts";
import { type Check, failedCheck } from "./check.ts";
import { doctorChecks, jitChecks, preflightChecks, type WorkflowRequires } from "./index.ts";

const passing = (id: string): Check => ({
  id,
  label: id,
  run: async () => ({ ok: true }),
});

test("runChecks runs every check and reports each failure", async () => {
  const report = await runChecks([
    failedCheck("a", "check A", "A is broken", "fix A"),
    passing("b"),
    failedCheck("c", "check C", "C is broken", "fix C"),
  ]);
  expect(report.ok).toBe(false);
  expect(report.checks.map((outcome) => outcome.id)).toEqual(["a", "b", "c"]);
  expect(report.checks.filter((outcome) => !outcome.ok)).toHaveLength(2);
});

test("a report is green only when every check passed", async () => {
  const report = await runChecks([passing("a"), passing("b")]);
  expect(report.ok).toBe(true);
});

test("a check that throws becomes a failure, not a crash", async () => {
  const report = await runChecks([
    {
      id: "boom",
      label: "exploding check",
      run: async () => {
        throw new Error("kaboom");
      },
    },
    failedCheck("a", "check A", "A is broken", "fix A"),
  ]);
  expect(report.ok).toBe(false);
  const boom = report.checks[0];
  expect(boom?.ok).toBe(false);
  expect(boom).toMatchObject({ reason: expect.stringContaining("kaboom") });
  // The other failure still made it into the aggregate.
  expect(report.checks[1]).toMatchObject({ reason: "A is broken" });
  // Told apart from a refusal, so a caller may retry what never answered.
  expect(boom).toMatchObject({ unanswered: true });
  expect(report.checks[1]).not.toHaveProperty("unanswered");
});

test("a check that never answers times out into a failure, not a hung report", async () => {
  const report = await runChecks(
    [
      {
        id: "hangs",
        label: "hanging check",
        run: () => new Promise<never>(() => {}),
      },
      failedCheck("a", "check A", "A is broken", "fix A"),
    ],
    20,
  );
  expect(report.ok).toBe(false);
  expect(report.checks[0]).toMatchObject({
    ok: false,
    reason: expect.stringContaining("did not answer within 20ms"),
    unanswered: true,
  });
  expect(report.checks[1]).toMatchObject({ reason: "A is broken" });
});

test("a timeout repair names the check that timed out, not a doctor run that cannot reproduce it", async () => {
  const report = await runChecks(
    [{ id: "hangs", label: "hanging check", run: () => new Promise(() => {}) }],
    20,
  );
  const outcome = report.checks[0];
  expect(outcome).toMatchObject({
    ok: false,
    repair: expect.stringContaining("hangs"),
  });
  expect(outcome?.ok === false && outcome.repair).not.toContain("pnpm exec jigs doctor");
});

test("formatFailures indents every repair line under its failure and skips the passes", () => {
  const text = formatFailures({
    ok: false,
    checks: [
      {
        id: "a",
        label: "check A",
        ok: false,
        reason: "broken",
        repair: "fix A",
      },
      { id: "b", label: "check B", ok: true },
      {
        id: "c",
        label: "check C",
        ok: false,
        reason: "worse",
        repair: "set C in .env\nthen: `pnpm exec jigs service restart`",
      },
    ],
  });
  expect(text).toBe(
    [
      "check A: broken",
      "  → fix A",
      "check C: worse",
      "  → set C in .env",
      "    then: `pnpm exec jigs service restart`",
    ].join("\n"),
  );
});

const preflightIds = (requires: WorkflowRequires): string[] =>
  preflightChecks(requires).map((check) => check.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a workflow requiring aws gets the credentials check", () => {
  expect(preflightIds({ aws: true })).toContain("aws.credentials");
});

test("a workflow that does not require aws does not get it", () => {
  expect(preflightIds({ agents: { builder: harnesses.claude({ model: "opus" }) } })).not.toContain(
    "aws.credentials",
  );
});

test("preflight installs only the harnesses declared by the workflow", () => {
  const ids = preflightIds({ agents: { builder: harnesses.claude({ model: "opus" }) } });
  expect(ids).toContain("harness.claude-cli");
  expect(ids).not.toContain("harness.codex-cli");
  expect(ids).not.toContain("harness.pi-cli");
});

test("preflight checks the model source each Pi agent carries, each check once", () => {
  const ids = preflightIds({
    agents: {
      a: harnesses.pi(models.openrouter("x", { apiKeyEnv: "TEAM_KEY" })),
      b: harnesses.pi(models.openaiCodex("gpt")),
      c: harnesses.pi(models.openrouter("y", { apiKeyEnv: "TEAM_KEY" })),
    },
  });
  expect(ids).toEqual(["harness.pi-cli", "model.team-key", "harness.pi-openai-codex-auth"]);
});

test("preflight checks a Pi agent's OpenAI-compatible endpoint and key", () => {
  const ids = preflightIds({
    agents: {
      local: harnesses.pi(
        models.openaiCompatible({
          name: "studio",
          baseUrl: "http://localhost:1234/v1",
          model: "local",
          apiKeyEnv: "STUDIO_TOKEN",
        }),
      ),
    },
  });
  expect(ids).toEqual(["harness.pi-cli", "model.openai-compatible-studio", "model.studio-token"]);
});

test("preflight lists a credential shared by a model and a Pi agent once", () => {
  const ids = preflightIds({
    agents: { a: harnesses.pi(models.openrouter("x")) },
    models: [models.openrouter("y")],
  });
  expect(ids.filter((id) => id === "model.openrouter-api-key")).toHaveLength(1);
});

test("doctor checks the model source each Pi agent carries and names the workflows", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("TEAM_KEY", "");
  const checks = doctorChecks({
    one: {
      requires: { agents: { a: harnesses.pi(models.openrouter("x", { apiKeyEnv: "TEAM_KEY" })) } },
    },
    two: {
      requires: {
        agents: {
          b: harnesses.pi(models.openrouter("y", { apiKeyEnv: "TEAM_KEY" })),
          c: harnesses.pi(models.openaiCodex("gpt")),
        },
      },
    },
  });
  const ids = checks.map((check) => check.id);
  expect(ids.filter((id) => id.startsWith("harness.") || id.startsWith("model."))).toEqual([
    "harness.pi-cli",
    "model.team-key",
    "harness.pi-openai-codex-auth",
  ]);
  const key = (await runChecks(checks.filter((check) => check.id === "model.team-key"))).checks;
  expect(key).toEqual([
    expect.objectContaining({
      ok: false,
      reason: expect.stringContaining("(needed by workflows one, two)"),
    }),
  ]);
});

test("doctor checks the model sources a workflow declares", () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  const ids = doctorChecks({
    triage: { requires: { models: [models.openrouter("m", { apiKeyEnv: "TEAM_KEY" })] } },
  }).map((check) => check.id);
  expect(ids).toContain("model.team-key");
});

test("model-source requirements check the descriptor's exact credential", () => {
  expect(
    preflightIds({
      models: [models.openrouter("model", { apiKeyEnv: "TEAM_OPENROUTER_KEY" })],
    }),
  ).toContain("model.team-openrouter-key");
  expect(
    preflightIds({
      models: [models.openrouter("model", { apiKeyEnv: "TEAM_OPENROUTER_KEY" })],
    }),
  ).not.toContain("model.openrouter-api-key");
});

test("preflight rejects a missing selected credential even when the default is present", async () => {
  vi.stubEnv("TEAM_OPENROUTER_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "unrelated-secret");
  const report = await runChecks(
    preflightChecks({
      models: [models.openrouter("model", { apiKeyEnv: "TEAM_OPENROUTER_KEY" })],
    }),
  );

  expect(report.ok).toBe(false);
  expect(report.checks).toEqual([
    expect.objectContaining({
      id: "model.team-openrouter-key",
      ok: false,
      reason: expect.stringContaining("TEAM_OPENROUTER_KEY is not set"),
    }),
  ]);
  expect(JSON.stringify(report)).not.toContain("unrelated-secret");
});

test("model requirements reject kind-only declarations", () => {
  const requires: WorkflowRequires = {
    // @ts-expect-error preflight needs the full descriptor to select credentials and endpoint settings
    models: ["openrouter"],
  };
  expect(requires.models).toEqual(["openrouter"]);
});

test("doctor does not infer a model credential without a descriptor", () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("OPENROUTER_API_KEY", "configured");
  expect(doctorChecks({}).map((check) => check.id)).not.toContain("model.openrouter-api-key");
});

test("doctor omits checks that require a call-site model descriptor", () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  expect(doctorChecks({}).map((check) => check.id)).not.toContain(
    "model.openai-compatible-runtime",
  );
});

test("doctor checks aws only when a workflow requires it", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("AWS_PROFILE", "some-profile");
  expect(doctorChecks({ hello: {} }).map((c) => c.id)).not.toContain("aws.credentials");
  vi.stubEnv("AWS_PROFILE", "");
  const report = await runChecks(doctorChecks({ hello: {}, deploy: { requires: { aws: true } } }));
  expect(report.checks.find((c) => c.id === "aws.credentials")).toMatchObject({
    ok: false,
    reason: expect.stringContaining("(needed by workflow deploy)"),
  });
});

test("a workflow's declared secrets are checked by preflight and doctor", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("SNOWFLAKE_TOKEN", "");
  expect(preflightIds({ secrets: ["SNOWFLAKE_TOKEN"] })).toEqual(["secret.SNOWFLAKE_TOKEN"]);
  const report = await runChecks(
    doctorChecks({ hello: {}, sync: { requires: { secrets: ["SNOWFLAKE_TOKEN"] } } }),
  );
  expect(report.checks.find((c) => c.id === "secret.SNOWFLAKE_TOKEN")).toMatchObject({
    ok: false,
    reason: expect.stringContaining("(needed by workflow sync)"),
  });
});

test("generic workflows require neither Linear nor GitHub credentials", async () => {
  vi.stubEnv("LINEAR_API_KEY", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  expect(preflightIds({})).toEqual([]);
  expect((await runChecks(preflightChecks({}))).ok).toBe(true);
});

test("workflows check only explicitly declared integrations", async () => {
  vi.stubEnv("LINEAR_API_KEY", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  expect(preflightIds({ integrations: ["linear"] })).toEqual(["linear.identity"]);
  expect(preflightIds({ integrations: ["github"] })).toEqual(["github.identity"]);
  const report = await runChecks(preflightChecks({ integrations: ["linear", "github"] }));
  expect(report.ok).toBe(false);
  expect(report.checks).toHaveLength(2);
});

function factoryWith(config: string): string {
  const factory = makeTmpDir();
  onTestFinished(() => removeTmpDir(factory));
  writeFileSync(path.join(factory, "jigs.config.ts"), `export default ${config}`);
  vi.stubEnv("JIGS_FACTORY_ROOT", factory);
  return factory;
}

test("doctor checks no provider credential for a factory whose workflows require none", async () => {
  factoryWith(
    '{ service: { dashboardPort: 9090 }, github: { identities: [{ mode: "pat" }] }, linear: { identity: { mode: "key" } } }',
  );
  for (const name of ["LINEAR_API_KEY", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "GITHUB_TOKEN"])
    vi.stubEnv(name, "");
  vi.stubEnv("LINEAR_API_KEY", "set-but-unused");
  const report = await runChecks(doctorChecks({ hello: {} }));
  expect(report).toEqual({ ok: true, checks: [] });
});

test("doctor checks each provider a workflow requires and names the workflows", async () => {
  factoryWith(
    '{ service: { dashboardPort: 9090 }, github: { identities: [{ mode: "pat" }] }, linear: { identity: { mode: "key" } } }',
  );
  for (const name of ["LINEAR_API_KEY", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "GITHUB_TOKEN"])
    vi.stubEnv(name, "");
  const report = await runChecks(
    doctorChecks({
      hello: {},
      triage: { requires: { integrations: ["linear"] } },
      ship: { requires: { integrations: ["linear", "github"] } },
    }),
  );
  expect(report.checks.find((c) => c.id === "linear.identity")).toMatchObject({
    ok: false,
    reason:
      "linear.identity uses key but LINEAR_API_KEY is not set (needed by workflows triage, ship)",
  });
  expect(report.checks.find((c) => c.id === "github.identity")).toMatchObject({
    ok: false,
    reason: expect.stringContaining("(needed by workflow ship)"),
  });
});

test("doctor checks the factory's Linear operator, preflight never does", () => {
  factoryWith(
    '{ service: { dashboardPort: 9090 }, linear: { identity: { mode: "key" }, operator: "salim@example.com" } }',
  );
  const linear = { integrations: ["linear" as const] };
  expect(
    doctorChecks({
      ship: { requires: linear },
    }).map((check) => check.id),
  ).toEqual(["linear.identity", "linear.operator"]);
  expect(preflightIds(linear)).toEqual(["linear.identity"]);
});

test("doctor checks a set Linear operator even when no workflow requires Linear", () => {
  factoryWith(
    '{ service: { dashboardPort: 9090 }, linear: { identity: { mode: "key" }, operator: "salim@example.com" } }',
  );
  expect(doctorChecks({ hello: {} }).map((check) => check.id)).toEqual([
    "linear.identity",
    "linear.operator",
  ]);
});

test("doctor checks a provider the factory configuration asks for", () => {
  const ids = () => doctorChecks({ hello: {} }).map((check) => check.id);
  factoryWith(
    '{ service: { dashboardPort: 9090 }, bindings: { api: { remote: "https://github.com/o/api.git" } } }',
  );
  expect(ids()).toContain("github.identity");
  expect(ids()).not.toContain("linear.identity");
  factoryWith('{ service: { dashboardPort: 9090 }, linear: { identity: { mode: "app" } } }');
  expect(ids()).toContain("linear.identity");
  expect(ids()).not.toContain("github.identity");
});

test("a slack section asks doctor for the Slack checks, and Socket Mode adds its own", () => {
  const ids = () => doctorChecks({ hello: {} }).map((check) => check.id);
  factoryWith("{ service: { dashboardPort: 9090 } }");
  expect(ids()).not.toContain("slack.identity");
  factoryWith("{ service: { dashboardPort: 9090 }, slack: { socketMode: false } }");
  expect(ids()).toEqual(["slack.identity"]);
  factoryWith("{ service: { dashboardPort: 9090 }, slack: { socketMode: true } }");
  expect(ids()).toEqual(["slack.identity", "slack.socket-mode"]);
});

test("a workflow requiring slack preflights the bot token, never the Socket Mode connection", async () => {
  factoryWith("{ service: { dashboardPort: 9090 }, slack: { socketMode: true } }");
  vi.stubEnv("SLACK_BOT_TOKEN", "");
  vi.stubEnv("SLACK_APP_TOKEN", "");
  const slack = { integrations: ["slack" as const] };
  expect(preflightIds(slack)).toEqual(["slack.identity"]);
  const report = await runChecks(doctorChecks({ answer: { requires: slack } }));
  expect(report.checks.find((c) => c.id === "slack.identity")).toMatchObject({
    ok: false,
    reason: "SLACK_BOT_TOKEN is not set (needed by workflow answer)",
  });
});

test("a factory config that cannot be read fails the Linear check as itself", async () => {
  const factory = makeTmpDir();
  onTestFinished(() => removeTmpDir(factory));
  writeFileSync(
    path.join(factory, "jigs.config.ts"),
    'export default { service: { dashboardPort: 9090 }, linear: { identity: { mode: "nope" } } }',
  );
  vi.stubEnv("JIGS_FACTORY_ROOT", factory);
  vi.stubEnv("LINEAR_API_KEY", "configured");
  const report = await runChecks(preflightChecks({ integrations: ["linear"] }));
  expect(report.checks).toEqual([
    expect.objectContaining({
      id: "linear.identity",
      ok: false,
      reason: expect.stringContaining("jigs.config.ts"),
      repair: "repair jigs.config.ts, then: `pnpm exec jigs service restart`",
    }),
  ]);
  expect(report.checks[0]).not.toMatchObject({ reason: expect.stringContaining("rejected") });
});

test("doctor checks no harness for a factory whose workflows require none", () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  const ids = doctorChecks({ hello: {} }).map((check) => check.id);
  expect(ids.filter((id) => id.startsWith("harness."))).toEqual([]);
});

test("doctor checks each required harness and names the workflows that need it", async () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("PATH", "/nowhere");
  vi.stubEnv("JIGS_CLAUDE_EXECUTABLE", "");
  const harness = doctorChecks({
    hello: {},
    review: { requires: { agents: { reviewer: harnesses.claude({ model: "opus" }) } } },
    ship: {
      requires: {
        agents: {
          builder: harnesses.claude({ model: "opus" }),
          reviewer: harnesses.codex({ model: "gpt-5.5" }),
        },
      },
    },
  }).filter((check) => check.id.startsWith("harness."));
  expect(harness.map((check) => check.id)).toEqual([
    "harness.claude-cli",
    "harness.claude-auth",
    "harness.codex-cli",
    "harness.codex-auth",
  ]);
  const cli = (await runChecks(harness)).checks.find((check) => check.id === "harness.claude-cli");
  expect(cli).toMatchObject({
    ok: false,
    reason: "claude not found on PATH (needed by workflows review, ship)",
  });
});

const PAGERDUTY =
  'pagerduty: { identity: { mode: "app", subdomain: "acme", region: "us", from: "oncall@example.com" } }';

test("a workflow requiring PagerDuty in a factory without a pagerduty section fails preflight with the section to add", async () => {
  factoryWith("{ service: { dashboardPort: 9090 } }");
  const report = await runChecks(preflightChecks({ integrations: ["pagerduty"] }));
  expect(report.checks).toEqual([
    expect.objectContaining({
      id: "pagerduty.identity",
      ok: false,
      reason: "jigs.config.ts has no pagerduty section",
      repair: expect.stringContaining('add pagerduty: { identity: { mode: "app"'),
    }),
  ]);
});

test("preflight checks the PagerDuty identity only, doctor adds the from user", async () => {
  factoryWith(`{ service: { dashboardPort: 9090 }, ${PAGERDUTY} }`);
  vi.stubEnv("PAGERDUTY_CLIENT_ID", "");
  vi.stubEnv("PAGERDUTY_CLIENT_SECRET", "");
  const pagerduty = { integrations: ["pagerduty" as const] };
  expect(preflightIds(pagerduty)).toEqual(["pagerduty.identity"]);
  expect(doctorChecks({ triage: { requires: pagerduty } }).map((check) => check.id)).toEqual([
    "pagerduty.identity",
    "pagerduty.from",
  ]);
  const report = await runChecks(preflightChecks(pagerduty));
  expect(report.checks[0]).toMatchObject({
    ok: false,
    reason: "PAGERDUTY_CLIENT_ID and PAGERDUTY_CLIENT_SECRET are not set",
  });
});

test("doctor checks PagerDuty when the factory configures it, and not otherwise", () => {
  const ids = () => doctorChecks({ hello: {} }).map((check) => check.id);
  factoryWith(`{ service: { dashboardPort: 9090 }, ${PAGERDUTY} }`);
  expect(ids()).toEqual(["pagerduty.identity", "pagerduty.from"]);
  factoryWith("{ service: { dashboardPort: 9090 } }");
  expect(ids().filter((id) => id.startsWith("pagerduty."))).toEqual([]);
});

test("doctor checks PagerDuty for a trigger that polls it, naming the trigger", async () => {
  factoryWith("{ service: { dashboardPort: 9090 } }");
  const checks = doctorChecks({ hello: {} }, { pages: "pagerduty" });
  expect(checks.map((check) => check.id).filter((id) => id.startsWith("pagerduty."))).toEqual([
    "pagerduty.identity",
  ]);
  const report = await runChecks(checks.filter((check) => check.id === "pagerduty.identity"));
  expect(report.checks[0]).toMatchObject({
    ok: false,
    reason: expect.stringContaining("(needed by trigger pages)"),
  });
});

const PROBE_SERVER = fileURLToPath(
  new URL("../steps/agents/harnesses/live/fixtures/mcp-probe-server.mjs", import.meta.url),
);

// A relative path, so the probe passes only where doctor starts the server
// from the factory root.
const probeServer = (credential: string) => ({
  command: "node",
  args: ["./mcp-probe-server.mjs"],
  env: { PROBE_TOKEN: credential },
  probe: { tool: "get_probe_token" },
});

test("doctor probes each MCP server a required agent declares, from the factory root", async () => {
  const factory = factoryWith("{ service: { dashboardPort: 9090 } }");
  copyFileSync(PROBE_SERVER, path.join(factory, "mcp-probe-server.mjs"));
  vi.stubEnv("PROBE_SOURCE", "from-factory");
  const builder = harnesses.claude({
    model: "opus",
    mcpServers: { probe: probeServer("PROBE_SOURCE") },
  });
  const report = await runChecks(
    doctorChecks({ ship: { requires: { agents: { builder } } } }).filter((check) =>
      check.id.startsWith("mcp."),
    ),
  );
  expect(report.checks).toEqual([{ id: "mcp.probe", label: "MCP server probe", ok: true }]);
});

test("doctor names the workflows whose agents declare a failing MCP server", async () => {
  factoryWith("{ service: { dashboardPort: 9090 } }");
  const builder = harnesses.claude({
    model: "opus",
    mcpServers: { github: probeServer("MISSING_PROBE_TOKEN") },
  });
  const report = await runChecks(
    doctorChecks({
      hello: {},
      ship: { requires: { agents: { builder } } },
      fix: { requires: { agents: { builder, reviewer: builder } } },
    }).filter((check) => check.id.startsWith("mcp.")),
  );
  expect(report.checks).toEqual([
    {
      id: "mcp.github",
      label: "MCP server github",
      ok: false,
      reason: expect.stringMatching(/MISSING_PROBE_TOKEN.*\(needed by workflows ship, fix\)$/),
      repair: expect.stringContaining("set MISSING_PROBE_TOKEN in"),
    },
  ]);
});

test("doctor reports an agent whose environment cannot be planned, rather than failing", async () => {
  factoryWith("{ service: { dashboardPort: 9090 } }");
  // Built by hand: the harness builder would have filled in `compat`.
  const builder = {
    kind: "pi",
    model: {
      kind: "openai-compatible",
      name: "local",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
    },
    mcpServers: { probe: { ...probeServer("PROBE_SOURCE"), tools: ["get_probe_token"] } },
  } as unknown as Harness;
  const checks = doctorChecks({ ship: { requires: { agents: { builder } } } });
  const report = await runChecks(checks.filter((check) => check.id.startsWith("mcp.")));
  expect(report.checks).toEqual([
    {
      id: "mcp.probe",
      label: "MCP server probe",
      ok: false,
      reason: expect.stringMatching(/compatibility settings \(needed by workflow ship\)$/),
      repair: expect.any(String),
    },
  ]);
});

test("preflight and doctor check each declared skill folder, doctor naming the workflows", async () => {
  const root = makeTmpDir();
  onTestFinished(() => removeTmpDir(root));
  vi.stubEnv("JIGS_FACTORY_ROOT", root);
  const analyst = harnesses.claude({ model: "opus", skills: ["skills/snowflake"] });
  expect(preflightIds({ agents: { analyst } })).toContain("skills.skills/snowflake");

  const skills = doctorChecks({
    report: { requires: { agents: { analyst } } },
    audit: { requires: { agents: { analyst } } },
  }).filter((check) => check.id.startsWith("skills."));
  expect(skills.map((check) => check.id)).toEqual(["skills.skills/snowflake"]);
  expect((await runChecks(skills)).checks[0]).toMatchObject({
    ok: false,
    reason: `no skill folder at ${path.join(root, "skills/snowflake")} (needed by workflows report, audit)`,
  });
});

test("the just-in-time checks cover the skills of the harness the body built", () => {
  const harness = harnesses.codex({ model: "gpt-5.5", skills: ["/opt/skills/pdf"] });
  expect(jitChecks({ harness, cwd: "/work" }, {}).map((check) => check.id)).toContain(
    "skills./opt/skills/pdf",
  );
});

test("doctor shows a skill path once when no earlier entry could clash with it", () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  const ids = doctorChecks({
    report: { requires: { agents: { a: harnesses.claude({ model: "opus", skills: ["s/a"] }) } } },
    audit: {
      requires: { agents: { b: harnesses.codex({ model: "gpt-5.5", skills: ["s/b", "s/a"] }) } },
    },
  })
    .map((check) => check.id)
    .filter((id) => id.startsWith("skills."));
  expect(ids).toEqual(["skills.s/a", "skills.s/b"]);
});
