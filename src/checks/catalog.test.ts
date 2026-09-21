import { afterEach, expect, test, vi } from "vitest";
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
  expect(outcome?.ok === false && outcome.repair).not.toContain("jigs doctor");
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
  expect(preflightIds({ harnesses: ["claude"] })).not.toContain("aws.credentials");
});

test("model-source requirements are included in preflight", () => {
  expect(preflightIds({ models: ["openrouter"] })).toContain("model.openrouter-api-key");
});

test("doctor checks the OpenRouter credential only when it is configured", () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  expect(doctorChecks().map((check) => check.id)).not.toContain("model.openrouter-api-key");

  vi.stubEnv("OPENROUTER_API_KEY", "configured");
  expect(doctorChecks().map((check) => check.id)).toContain("model.openrouter-api-key");
});

test("doctor checks aws only when a profile is set, having no manifest to read", () => {
  // Doctor asks for every declared binding, so it reads a factory config;
  // this one does not exist, which collapses to a single failed check.
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("AWS_PROFILE", "");
  expect(doctorChecks().map((c) => c.id)).not.toContain("aws.credentials");
  vi.stubEnv("AWS_PROFILE", "some-profile");
  expect(doctorChecks().map((c) => c.id)).toContain("aws.credentials");
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
  expect(preflightIds({ integrations: ["linear"] })).toEqual(["core.linear-api-key"]);
  expect(preflightIds({ integrations: ["github"] })).toEqual([
    "github.identity",
    "github.merge-policy",
  ]);
  const report = await runChecks(preflightChecks({ integrations: ["linear", "github"] }));
  expect(report.ok).toBe(false);
  expect(report.checks).toHaveLength(3);
});

test("doctor checks credentials only for configured integrations", () => {
  vi.stubEnv("JIGS_FACTORY_ROOT", "/nowhere");
  vi.stubEnv("LINEAR_API_KEY", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  const ids = () => doctorChecks().map((check) => check.id);
  expect(ids()).not.toContain("core.linear-api-key");
  expect(ids()).not.toContain("linear.webhook");
  // GitHub is not detected from the environment: an App identity sets no
  // variable, so the configuration is the only thing that could say.
  expect(ids()).toContain("github.identity");
  vi.stubEnv("LINEAR_API_KEY", "configured");
  expect(ids()).toContain("core.linear-api-key");
});
