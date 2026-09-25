import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { makeTmpDir, removeTmpDir } from "../test-fixtures.ts";
import { harnesses, models } from "../workflow/agents/harness-config.ts";
import { type Check, failedCheck, formatFailures, runChecks } from "./catalog.ts";
import { doctorChecks, preflightChecks, type WorkflowRequires } from "./index.ts";

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

test("formatFailures renders one repair line per failure and skips the passes", () => {
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
        repair: "fix C",
      },
    ],
  });
  expect(text).toBe("check A: broken\n  → fix A\ncheck C: worse\n  → fix C");
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

function factoryWith(config: string): void {
  const factory = makeTmpDir();
  onTestFinished(() => removeTmpDir(factory));
  writeFileSync(path.join(factory, "jigs.config.ts"), `export default ${config}`);
  vi.stubEnv("JIGS_FACTORY_ROOT", factory);
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
      repair: "repair jigs.config.ts, then: pnpm exec jigs service restart",
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
