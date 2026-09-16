import { expect, test } from "vitest";
import { runChecks } from "./catalog.ts";
import { type CoreProbes, coreChecks } from "./core.ts";

function probes(overrides: Partial<CoreProbes> = {}) {
  const calls: string[] = [];
  const base: CoreProbes = {
    linearViewer: async () => {
      calls.push("linear");
    },
  };
  return { probes: { ...base, ...overrides }, calls };
}

const outcome = async (env: NodeJS.ProcessEnv, id: string, p: CoreProbes) => {
  const report = await runChecks(coreChecks(p, env));
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

test("an unset LINEAR_API_KEY fails before any probe runs", async () => {
  const { probes: p, calls } = probes();
  const check = await outcome({}, "core.linear-api-key", p);
  expect(check).toMatchObject({
    ok: false,
    reason: expect.stringContaining("LINEAR_API_KEY is not set"),
    repair: expect.stringContaining("the factory repo's .env"),
  });
  expect(calls).not.toContain("linear");
});

test("a rejected LINEAR_API_KEY surfaces the provider error and a re-issue repair", async () => {
  const { probes: p } = probes({
    linearViewer: async () => {
      throw new Error("Linear API 401: authentication required");
    },
  });
  const check = await outcome({ LINEAR_API_KEY: "stale" }, "core.linear-api-key", p);
  expect(check).toMatchObject({
    ok: false,
    reason: expect.stringContaining("Linear API 401"),
    repair: expect.stringContaining("re-issue the token"),
  });
});

test("a present and accepted credential is green", async () => {
  const { probes: p, calls } = probes();
  const report = await runChecks(coreChecks(p, { LINEAR_API_KEY: "lin" }));
  expect(report.ok).toBe(true);
  expect(calls).toEqual(["linear"]);
});

test("an integration nobody declared is not checked", async () => {
  const { probes: p } = probes();
  expect(await runChecks(coreChecks(p, {}, ["github"]))).toMatchObject({ ok: true, checks: [] });
});
