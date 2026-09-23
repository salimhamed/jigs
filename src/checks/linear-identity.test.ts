import { expect, test } from "vitest";
import type { LinearIdentity } from "../config/factory-config.ts";
import { runChecks } from "./catalog.ts";
import { type LinearIdentityProbes, linearIdentityChecks } from "./linear-identity.ts";

function probes(overrides: Partial<LinearIdentityProbes> = {}) {
  const calls: string[] = [];
  const base: LinearIdentityProbes = {
    viewer: async () => {
      calls.push("viewer");
      return { id: "u1", name: "jigs-factory" };
    },
  };
  return { probes: { ...base, ...overrides }, calls };
}

const outcome = async (
  identity: LinearIdentity,
  env: Record<string, string>,
  p: LinearIdentityProbes,
) => {
  const report = await runChecks(linearIdentityChecks(identity, p, (name) => env[name]));
  const found = report.checks.find((check) => check.id === "linear.identity");
  if (found === undefined) throw new Error("no linear.identity check");
  return found;
};

const rejecting = () =>
  probes({
    viewer: async () => {
      throw new Error("Linear API 401: authentication required");
    },
  }).probes;

test("an unset LINEAR_API_KEY fails before any probe runs", async () => {
  const { probes: p, calls } = probes();
  expect(await outcome({ mode: "key" }, {}, p)).toMatchObject({
    ok: false,
    reason: "linear.identity uses key but LINEAR_API_KEY is not set",
    repair: expect.stringContaining(
      "set LINEAR_API_KEY (a Linear personal API key) in the factory repo's .env",
    ),
  });
  expect(calls).toEqual([]);
});

test("an app identity names each client variable it is missing", async () => {
  const { probes: p, calls } = probes();
  expect(await outcome({ mode: "app" }, { LINEAR_CLIENT_ID: "id" }, p)).toMatchObject({
    ok: false,
    reason: "linear.identity uses app but LINEAR_CLIENT_SECRET is not set",
    repair: expect.stringContaining("set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET"),
  });
  expect(await outcome({ mode: "app" }, {}, p)).toMatchObject({
    reason: "linear.identity uses app but LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are not set",
  });
  expect(calls).toEqual([]);
});

test("a rejected key surfaces the provider error and a re-issue repair", async () => {
  expect(await outcome({ mode: "key" }, { LINEAR_API_KEY: "stale" }, rejecting())).toMatchObject({
    ok: false,
    reason: expect.stringContaining("Linear API 401"),
    repair: expect.stringContaining("re-issue the key"),
  });
});

test("rejected app credentials point back at the OAuth application", async () => {
  const env = { LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "wrong" };
  expect(await outcome({ mode: "app" }, env, rejecting())).toMatchObject({
    ok: false,
    reason: expect.stringContaining("Linear API 401"),
    repair: expect.stringContaining("against the Linear OAuth application"),
  });
});

test("an accepted credential is green and names who jigs acts as", async () => {
  const { probes: p, calls } = probes();
  expect(await outcome({ mode: "key" }, { LINEAR_API_KEY: "lin" }, p)).toEqual({
    id: "linear.identity",
    label: "Linear identity",
    ok: true,
    detail: "acting as jigs-factory",
  });
  const env = { LINEAR_CLIENT_ID: "id", LINEAR_CLIENT_SECRET: "secret" };
  expect(await outcome({ mode: "app" }, env, p)).toMatchObject({
    ok: true,
    detail: "acting as the app jigs-factory",
  });
  expect(calls).toEqual(["viewer", "viewer"]);
});
