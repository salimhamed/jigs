import { afterEach, expect, test, vi } from "vitest";
import {
  type Check,
  failedCheck,
  formatFailures,
  runChecks,
} from "./catalog.ts";
import {
  type CoreProbes,
  doctorChecks,
  type PipelineRequires,
  preflightChecks,
} from "./index.ts";

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

const probes: CoreProbes = {
  linearViewer: async () => ({}),
  githubWhoami: async () => ({}),
};

const factoryRoot = () => "/nowhere";

const preflightIds = (requires: PipelineRequires): string[] =>
  preflightChecks({ factoryRoot, requires, probes }).map((check) => check.id);

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a pipeline requiring aws gets the credentials check", () => {
  expect(preflightIds({ aws: true })).toContain("aws.credentials");
});

test("a pipeline that does not require aws does not get it", () => {
  expect(preflightIds({ harnesses: ["claude"] })).not.toContain(
    "aws.credentials",
  );
});

test("doctor checks aws only when a profile is set, having no manifest to read", () => {
  vi.stubEnv("AWS_PROFILE", "");
  expect(doctorChecks({ factoryRoot, probes }).map((c) => c.id)).not.toContain(
    "aws.credentials",
  );
  vi.stubEnv("AWS_PROFILE", "some-profile");
  expect(doctorChecks({ factoryRoot, probes }).map((c) => c.id)).toContain(
    "aws.credentials",
  );
});
